import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type WorkStateCategory
} from '../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateMetadataInput,
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';
import { jiraProjectKeysFromJql, jqlWithoutOrderBy } from './jira-scope.js';
import type { JiraDeployment } from '../credential-contract.js';

const CLOUD_API_BASE = '/rest/api/3';
const SERVER_API_BASE = '/rest/api/2';

/**
 * Jira documents ids as strings, but Server/DC serializes some of them
 * (transition ids in particular) as JSON numbers depending on the version.
 * Accept both and normalize to the string form the rest of the adapter uses.
 */
const jiraIdSchema = z
  .union([z.string().min(1), z.number().int().nonnegative()])
  .transform(value => String(value));

const jiraIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().nullable().optional(),
        updated: z.string(),
        status: z
          .object({
            id: jiraIdSchema,
            name: z.string(),
            statusCategory: z.object({ key: z.string() }).passthrough()
          })
          .passthrough(),
        priority: z.object({ name: z.string() }).passthrough().nullish(),
        assignee: z
          .object({
            // Cloud identifies users by accountId; Server/DC by name (login)
            // with key as the immutable handle. Exactly one family is present.
            accountId: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
            key: z.string().min(1).optional(),
            displayName: z.string()
          })
          .passthrough()
          .nullish(),
        project: z.object({ key: z.string(), name: z.string() }).passthrough(),
        labels: z.array(z.string()).default([]),
        comment: z
          .object({
            comments: z.array(
              z
                .object({
                  body: z.unknown(),
                  created: z.string(),
                  author: z.object({ displayName: z.string() }).passthrough()
                })
                .passthrough()
            )
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

/** Cloud: POST /search/jql, opaque forward-only cursor, no total. */
const jiraSearchPageSchema = <Item extends z.ZodTypeAny>(item: Item) =>
  z
    .object({
      issues: z.array(item),
      nextPageToken: z.string().nullable().optional()
    })
    .passthrough();

/** Server/DC: POST /search, classic startAt/total offset paging. */
const jiraServerSearchPageSchema = <Item extends z.ZodTypeAny>(item: Item) =>
  z
    .object({
      startAt: z.number().int().nonnegative(),
      maxResults: z.number().int().positive(),
      total: z.number().int().nonnegative(),
      issues: z.array(item)
    })
    .passthrough();

/** Just enough of an issue to confirm identity in a scope check. */
const jiraIssueIdentitySchema = z
  .object({ id: z.string().min(1), key: z.string().min(1) })
  .passthrough();

/** Guards JQL interpolation; also what Jira itself accepts as an issue key. */
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u;

const jiraTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: jiraIdSchema,
          to: z
            .object({
              id: jiraIdSchema,
              name: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraCreatedIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    self: z.string().optional()
  })
  .passthrough();

const jiraCreateIssueTypeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    subtask: z.boolean().default(false)
  })
  .passthrough();

/**
 * The paginated createmeta endpoints exist on both deployments but name their
 * page differently: Cloud returns `issueTypes` / `fields`, while Server/DC
 * (verified on 8.20) returns the same rows under the generic `values` key.
 * Accepting only the Cloud name turns a working endpoint into a parse error,
 * which no status-code fallback would catch.
 */
const jiraCreateIssueTypesSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean().optional(),
    issueTypes: z.array(jiraCreateIssueTypeSchema).optional(),
    values: z.array(jiraCreateIssueTypeSchema).optional()
  })
  .passthrough()
  .refine(page => page.issueTypes !== undefined || page.values !== undefined, {
    message: 'Jira createmeta page contained no issue types'
  })
  .transform(page => ({
    ...page,
    issueTypes: page.issueTypes ?? page.values ?? []
  }));

const jiraCreateFieldSchema = z
  .object({
    fieldId: z.string().min(1),
    required: z.boolean().optional(),
    allowedValues: z.array(z.unknown()).optional()
  })
  .passthrough();

/** Same Cloud `fields` vs Server/DC `values` split as the issue-type page. */
const jiraCreateFieldsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean().optional(),
    fields: z.array(jiraCreateFieldSchema).optional(),
    values: z.array(jiraCreateFieldSchema).optional()
  })
  .passthrough()
  .refine(page => page.fields !== undefined || page.values !== undefined, {
    message: 'Jira createmeta page contained no fields'
  })
  .transform(page => ({ ...page, fields: page.fields ?? page.values ?? [] }));

/**
 * The pre-9.x Server/DC createmeta shape, still the only one on older Data
 * Center releases: a single unpaginated document keyed by project, with each
 * issue type's fields as an object rather than a list.
 */
const jiraLegacyCreateMetaSchema = z
  .object({
    projects: z.array(
      z
        .object({
          key: z.string().min(1),
          issuetypes: z.array(
            z
              .object({
                id: z.string().min(1),
                name: z.string().min(1),
                subtask: z.boolean().default(false),
                fields: z
                  .record(
                    z.string(),
                    z
                      .object({
                        required: z.boolean().optional(),
                        allowedValues: z.array(z.unknown()).optional()
                      })
                      .passthrough()
                  )
                  .default({})
              })
              .passthrough()
          )
        })
        .passthrough()
    )
  })
  .passthrough();

interface JiraCreateMetaField {
  fieldId: string;
  required: boolean;
  allowedValues?: unknown[];
}

interface JiraCreateMetaIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

function isNotFound(error: unknown): boolean {
  return error instanceof JiraHttpError && error.status === 404;
}

/** The identity of the caller, used to fill a required reporter. */
const jiraMyselfSchema = z
  .object({
    accountId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    key: z.string().min(1).optional()
  })
  .passthrough();

const jiraAssignableUserSchema = z
  .object({
    accountId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    displayName: z.string().min(1),
    active: z.boolean().optional()
  })
  .passthrough();

/**
 * The identifier to send back in a user field, and to match a created issue's
 * assignee against. Cloud uses accountId; Server/DC accepts the login `name`
 * (its `key` is an internal handle that user fields reject), so a Server user
 * without a name is simply not offered.
 */
function userIdentity(
  user: { accountId?: string; name?: string },
  deployment: JiraDeployment
): string | null {
  return deployment === 'cloud'
    ? (user.accountId ?? null)
    : (user.name ?? null);
}

/** The JSON shape a user field expects for the given deployment. */
function userFieldValue(
  identity: string,
  deployment: JiraDeployment
): Record<string, string> {
  return deployment === 'cloud'
    ? { accountId: identity }
    : { name: identity };
}
const jiraAssignableUsersSchema = z.array(jiraAssignableUserSchema);

const jiraLabelsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean(),
    values: z.array(z.string().min(1))
  })
  .passthrough();

/** Server/DC label source: /label is absent, autocomplete suggestions are not. */
const jiraLabelSuggestionsSchema = z
  .object({
    results: z.array(
      z.object({ value: z.string().min(1) }).passthrough()
    )
  })
  .passthrough();

const jiraNamedIdSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .passthrough();
const JIRA_CREATE_METADATA_PAGE_SIZE = 200;
const JIRA_LABEL_PAGE_SIZE = 1000;

function nextJiraPageStart(
  page: {
    startAt: number;
    maxResults: number;
    total: number;
    isLast?: boolean;
  },
  requestedStart: number,
  itemCount: number
): number | null {
  if (page.startAt !== requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  if (itemCount === 0 || page.isLast === true) return null;
  const nextStart = page.startAt + page.maxResults;
  if (nextStart >= page.total) return null;
  if (nextStart <= requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  return nextStart;
}

function jiraDescription(value: string) {
  return {
    type: 'doc',
    version: 1,
    content: value.split(/\r?\n/u).map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  };
}

function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content)
    ? record.content.map(adfText).filter(Boolean)
    : [];
  const joined = [own, ...children]
    .filter(Boolean)
    .join(record.type === 'paragraph' || record.type === 'heading' ? '' : '\n');
  return record.type === 'paragraph' || record.type === 'heading'
    ? `${joined}\n`
    : joined;
}

function stateCategory(key: string): WorkStateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

function toItem(
  baseUrl: string,
  issue: z.infer<typeof jiraIssueSchema>
): ExternalWorkItemDetail {
  return {
    source: 'jira',
    locator: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    description: adfText(issue.fields.description).trim(),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    status: issue.fields.status.name,
    stateCategory: stateCategory(issue.fields.status.statusCategory.key),
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    project: issue.fields.project.name,
    labels: issue.fields.labels,
    updatedAt: issue.fields.updated,
    comments: (issue.fields.comment?.comments ?? []).map(comment => ({
      author: comment.author.displayName,
      body: adfText(comment.body).trim(),
      createdAt: comment.created
    }))
  };
}

/**
 * Mirrors jiraBaseUrlSchema in credential-contract.ts: any HTTPS origin, with
 * a non-standard port and context path preserved (self-hosted Data Center is
 * routinely deployed as https://jira.example.com:8443/jira). Returns '' when
 * the value is unusable so the adapter reports itself unconfigured instead of
 * issuing a request somewhere unintended.
 *
 * Whether the host is allowed to be non-Atlassian is a deployment question and
 * is validated at config-save time, not here.
 */
function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return '';
    }
    const contextPath = parsed.pathname.replace(/\/+$/u, '');
    if (contextPath.includes('..')) return '';
    return `${parsed.origin}${contextPath}`;
  } catch {
    return '';
  }
}

interface JiraAuth {
  baseUrl: string;
  apiBase: string;
  deployment: JiraDeployment;
  email: string;
  apiToken: string;
}

/**
 * Cloud mints API tokens at id.atlassian.com and expects them as Basic
 * {email}:{token}. Server/DC issues Personal Access Tokens, which are sent
 * as a bearer credential and carry their own identity -- there is no email to
 * pair them with.
 */
function authorizationHeader(auth: JiraAuth): string {
  if (auth.deployment === 'server') return `Bearer ${auth.apiToken}`;
  const basic = Buffer.from(`${auth.email}:${auth.apiToken}`).toString(
    'base64'
  );
  return `Basic ${basic}`;
}

/**
 * Issues a request against an API path relative to the deployment's REST base
 * (`/rest/api/3` on Cloud, `/rest/api/2` on Server/DC).
 *
 * Redirects are refused rather than followed: an authenticated Jira REST call
 * has no legitimate reason to redirect, and a self-hosted instance behind SSO
 * answers an unauthenticated call with a 302 to a login page, which would
 * otherwise be parsed as a successful but nonsensical response.
 */
async function jiraRequest(
  auth: JiraAuth,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${auth.baseUrl}${auth.apiBase}${path}`, {
      ...init,
      // Never follow: a self-hosted Jira behind SSO answers an unauthenticated
      // REST call with a 302 to /login.jsp. 'manual' (rather than 'error')
      // still refuses to follow it, but lets the 3xx surface as a diagnosable
      // status instead of an opaque network failure.
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        authorization: authorizationHeader(auth),
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' })
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Jira');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new JiraHttpError(
      response.status,
      auth.deployment === 'cloud'
        ? 'Jira redirected to a sign-in page. A self-hosted site answers this way when Cloud is selected — switch the deployment to Server / Data Center.'
        : 'Jira redirected to a sign-in page, so the Personal Access Token was not accepted.'
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new JiraHttpError(response.status, authHint(auth, response.status));
  }
  return payload;
}

/** Carries the status code so callers can branch on 404 for optional endpoints. */
class JiraHttpError extends Error {
  readonly status: number;

  constructor(status: number, hint: string) {
    super(`Jira returned HTTP ${status}${hint ? `. ${hint}` : ''}`);
    this.name = 'JiraHttpError';
    this.status = status;
  }
}

/**
 * A 401/403 looks identical on the wire for a rejected Cloud API token and a
 * rejected Server PAT, but the user's next step differs, so name it.
 */
function authHint(auth: JiraAuth, status: number): string {
  if (status !== 401 && status !== 403) return '';
  return auth.deployment === 'server'
    ? 'The Personal Access Token was rejected. Recreate it in Jira under Profile -> Personal Access Tokens and update it in Manage.'
    : 'The email or API token was rejected. If this site is self-hosted, switch the deployment to Server / Data Center; otherwise create a new token at id.atlassian.com/manage-profile/security/api-tokens.';
}

export function createJiraAdapter(options: {
  enabled: boolean;
  baseUrl: string;
  deployment: JiraDeployment;
  email: string;
  apiToken: string | undefined;
  jql: string;
}): WorkSourceAdapter {
  const rawBaseUrl = options.baseUrl.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const deployment = options.deployment;
  const isServer = deployment === 'server';
  const email = options.email.trim();
  const apiToken = options.apiToken?.trim() ?? '';
  // Server/DC authenticates with the PAT alone -- requiring an email there
  // would leave a working configuration permanently reported as incomplete.
  const hasCredentials = Boolean(
    baseUrl && apiToken && (isServer || email)
  );
  const configured = options.enabled && hasCredentials;
  const auth: JiraAuth = {
    baseUrl,
    apiBase: isServer ? SERVER_API_BASE : CLOUD_API_BASE,
    deployment,
    email,
    apiToken
  };

  /**
   * One page of a JQL search, hiding the Cloud/Server pagination split behind
   * an opaque cursor. Cloud returns a token; for Server the cursor is the next
   * startAt offset rendered as a string.
   */
  async function searchPage<Item extends z.ZodTypeAny>(
    jql: string,
    request: { fields: string[]; maxResults: number; cursor: string | null },
    // Must match the requested field set: parsing a summary-only row with the
    // full issue schema fails on every field that was not asked for. Passed
    // explicitly rather than defaulted, because a default referring to Item
    // makes the parameter self-referential and collapses inference to any.
    itemSchema: Item
  ): Promise<{ issues: z.infer<Item>[]; nextCursor: string | null }> {
    if (!isServer) {
      const payload = await jiraRequest(auth, '/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          maxResults: request.maxResults,
          fields: request.fields,
          ...(request.cursor ? { nextPageToken: request.cursor } : {})
        })
      });
      const page = jiraSearchPageSchema(itemSchema).parse(payload);
      return {
        issues: page.issues,
        nextCursor: page.nextPageToken?.trim() || null
      };
    }
    const startAt = request.cursor ? Number(request.cursor) : 0;
    if (!Number.isSafeInteger(startAt) || startAt < 0) {
      throw new Error('Jira returned an invalid pagination offset');
    }
    const payload = await jiraRequest(auth, '/search', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: request.maxResults,
        fields: request.fields
      })
    });
    const page = jiraServerSearchPageSchema(itemSchema).parse(payload);
    if (page.startAt !== startAt) {
      throw new Error('Jira returned an invalid pagination offset');
    }
    const nextStart = page.startAt + page.issues.length;
    const done = page.issues.length === 0 || nextStart >= page.total;
    return {
      issues: page.issues,
      nextCursor: done ? null : String(nextStart)
    };
  }

  /**
   * Confirms the issue is inside the configured JQL by re-running that JQL
   * narrowed to the single key. Cloud also offers POST /jql/match for this,
   * but Server/DC support for it varies by version, and this form needs only
   * the search endpoint both deployments are guaranteed to have.
   */
  async function assertInScope(
    issue: z.infer<typeof jiraIssueSchema>
  ): Promise<void> {
    if (!JIRA_ISSUE_KEY.test(issue.key)) {
      throw new Error(`Jira returned an invalid issue key for ${issue.key}`);
    }
    const scopeJql = jqlWithoutOrderBy(options.jql.trim());
    if (!scopeJql) throw new Error('Jira scope JQL is empty');
    let page: { issues: { id: string }[]; nextCursor: string | null };
    try {
      page = await searchPage(
        `(${scopeJql}) AND issuekey = ${issue.key}`,
        { fields: ['summary'], maxResults: 1, cursor: null },
        jiraIssueIdentitySchema
      );
    } catch (error) {
      // Keep the upstream reason: a bad JQL and a rejected token are both
      // possible here and need different fixes.
      throw new Error(
        `Jira could not verify the configured scope: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!page.issues.some(match => match.id === issue.id)) {
      throw new Error(
        `Jira issue ${issue.key} is outside the configured scope`
      );
    }
  }

  async function loadIssue(
    locator: string,
    flags: { comments: boolean; verifyScope: boolean }
  ): Promise<z.infer<typeof jiraIssueSchema>> {
    const fields = [
      'summary',
      'description',
      'updated',
      'status',
      'priority',
      'assignee',
      'project',
      'labels',
      ...(flags.comments ? ['comment'] : [])
    ].join(',');
    const payload = await jiraRequest(
      auth,
      `/issue/${encodeURIComponent(locator)}?fields=${encodeURIComponent(fields)}`
    );
    const issue = jiraIssueSchema.parse(payload);
    if (issue.key !== locator) {
      throw new Error(`Jira returned the wrong issue for ${locator}`);
    }
    if (flags.verifyScope) await assertInScope(issue);
    return issue;
  }

  async function transitionOptions(locator: string): Promise<{
    issue: z.infer<typeof jiraIssueSchema>;
    options: Array<ExternalWorkStatusOption & { transitionId: string | null }>;
  }> {
    const issue = await loadIssue(locator, {
      comments: false,
      verifyScope: true
    });
    const payload = await jiraRequest(
      auth,
      `/issue/${encodeURIComponent(locator)}/transitions`
    );
    const transitions = jiraTransitionsSchema.parse(payload).transitions;
    const available = new Map<
      string,
      ExternalWorkStatusOption & { transitionId: string | null }
    >();
    available.set(issue.fields.status.id, {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      stateCategory: stateCategory(issue.fields.status.statusCategory.key),
      current: true,
      transitionId: null
    });
    for (const transition of transitions) {
      if (available.has(transition.to.id)) continue;
      available.set(transition.to.id, {
        id: transition.to.id,
        name: transition.to.name,
        stateCategory: stateCategory(transition.to.statusCategory.key),
        current: transition.to.id === issue.fields.status.id,
        transitionId: transition.id
      });
    }
    return { issue, options: [...available.values()] };
  }

  function assertProjectKey(destinationId: string): string {
    const projectKey = destinationId.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/u.test(projectKey)) {
      throw new Error('Enter a valid Jira project key');
    }
    const configuredProjectKeys = jiraProjectKeysFromJql(options.jql);
    if (
      configuredProjectKeys.length > 0 &&
      !configuredProjectKeys.includes(projectKey)
    ) {
      throw new Error(
        `Jira project ${projectKey} is outside the configured JQL scope`
      );
    }
    return projectKey;
  }

  /**
   * Loads the whole legacy createmeta document for a project. Data Center
   * releases before 9.x have no per-issue-type createmeta endpoints, so this
   * one unpaginated call is the only source of both issue types and fields.
   * Memoized by the caller so a metadata build fetches it at most once.
   */
  async function legacyCreateMeta(projectKey: string): Promise<
    Map<
      string,
      { issueType: JiraCreateMetaIssueType; fields: JiraCreateMetaField[] }
    >
  > {
    const payload = await jiraRequest(
      auth,
      `/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`
    );
    const parsed = jiraLegacyCreateMetaSchema.parse(payload);
    const project = parsed.projects.find(entry => entry.key === projectKey);
    const byIssueType = new Map<
      string,
      { issueType: JiraCreateMetaIssueType; fields: JiraCreateMetaField[] }
    >();
    for (const issueType of project?.issuetypes ?? []) {
      byIssueType.set(issueType.id, {
        issueType: {
          id: issueType.id,
          name: issueType.name,
          subtask: issueType.subtask
        },
        fields: Object.entries(issueType.fields).map(([fieldId, field]) => ({
          fieldId,
          required: field.required ?? false,
          allowedValues: field.allowedValues
        }))
      });
    }
    return byIssueType;
  }

  async function modernIssueTypes(
    projectKey: string
  ): Promise<JiraCreateMetaIssueType[]> {
    const issueTypesById = new Map<string, JiraCreateMetaIssueType>();
    let issueTypesStart = 0;
    for (;;) {
      const issueTypesPayload = await jiraRequest(
        auth,
        `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${issueTypesStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateIssueTypesSchema.parse(issueTypesPayload);
      for (const issueType of page.issueTypes) {
        issueTypesById.set(issueType.id, {
          id: issueType.id,
          name: issueType.name,
          subtask: issueType.subtask
        });
      }
      const nextStart = nextJiraPageStart(
        page,
        issueTypesStart,
        page.issueTypes.length
      );
      if (nextStart === null) break;
      issueTypesStart = nextStart;
    }
    return [...issueTypesById.values()];
  }

  async function modernCreateFields(
    projectKey: string,
    issueTypeId: string
  ): Promise<JiraCreateMetaField[]> {
    const fieldsById = new Map<string, JiraCreateMetaField>();
    let fieldsStart = 0;
    for (;;) {
      const fieldsPayload = await jiraRequest(
        auth,
        `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${fieldsStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateFieldsSchema.parse(fieldsPayload);
      for (const field of page.fields) {
        fieldsById.set(field.fieldId, {
          fieldId: field.fieldId,
          required: field.required ?? false,
          allowedValues: field.allowedValues
        });
      }
      const nextStart = nextJiraPageStart(
        page,
        fieldsStart,
        page.fields.length
      );
      if (nextStart === null) break;
      fieldsStart = nextStart;
    }
    return [...fieldsById.values()];
  }

  /**
   * Issue types and create-screen fields, preferring the paginated endpoints
   * and falling back to the legacy document when a Data Center release does
   * not expose them. The fallback is memoized so both lookups share one fetch.
   */
  function createMetaReader(projectKey: string) {
    let legacy: Promise<
      Map<
        string,
        { issueType: JiraCreateMetaIssueType; fields: JiraCreateMetaField[] }
      >
    > | null = null;
    const loadLegacy = () => (legacy ??= legacyCreateMeta(projectKey));
    return {
      async issueTypes(): Promise<JiraCreateMetaIssueType[]> {
        try {
          return await modernIssueTypes(projectKey);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          return [...(await loadLegacy()).values()].map(
            entry => entry.issueType
          );
        }
      },
      async fields(issueTypeId: string): Promise<JiraCreateMetaField[]> {
        try {
          return await modernCreateFields(projectKey, issueTypeId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          return (await loadLegacy()).get(issueTypeId)?.fields ?? [];
        }
      }
    };
  }

  /**
   * Every label known to the instance, for the create dialog's suggestions.
   *
   * Cloud paginates /label. Server/DC has no such endpoint (verified 404 on
   * 8.20) and exposes the same vocabulary through JQL autocomplete, which
   * returns the full list in one unpaginated response.
   */
  async function loadLabels(): Promise<string[]> {
    if (isServer) {
      const payload = await jiraRequest(
        auth,
        '/jql/autocompletedata/suggestions?fieldName=labels'
      );
      const suggestions = jiraLabelSuggestionsSchema.parse(payload);
      return [...new Set(suggestions.results.map(result => result.value))];
    }
    const labels = new Set<string>();
    let labelsStart = 0;
    for (;;) {
      const payload = await jiraRequest(
        auth,
        `/label?startAt=${labelsStart}&maxResults=${JIRA_LABEL_PAGE_SIZE}`
      );
      const page = jiraLabelsSchema.parse(payload);
      for (const label of page.values) labels.add(label);
      const nextStart = nextJiraPageStart(
        page,
        labelsStart,
        page.values.length
      );
      if (nextStart === null) break;
      labelsStart = nextStart;
    }
    return [...labels];
  }

  /**
   * The reporter value to send when the create screen requires one, or null
   * when it does not. Uses the authenticated account, which is the identity
   * Cloud would have applied implicitly.
   */
  async function requiredReporterField(
    projectKey: string,
    issueTypeId: string
  ): Promise<Record<string, string> | null> {
    const fields = await createMetaReader(projectKey).fields(issueTypeId);
    const required = fields.some(
      field => field.fieldId === 'reporter' && field.required
    );
    if (!required) return null;
    const me = jiraMyselfSchema.parse(await jiraRequest(auth, '/myself'));
    const identity = userIdentity(me, deployment);
    if (!identity) {
      throw new Error(
        'Jira requires a reporter but did not identify the authenticated user'
      );
    }
    return userFieldValue(identity, deployment);
  }

  function confirmAssignee(
    assignee: z.infer<typeof jiraIssueSchema>['fields']['assignee']
  ) {
    if (!assignee) return { confirmed: true as const, id: null };
    const identity = userIdentity(assignee, deployment);
    return identity
      ? { confirmed: true as const, id: identity }
      : { confirmed: false as const };
  }

  async function createMetadata(input: ExternalWorkItemCreateMetadataInput) {
    const projectKey = assertProjectKey(input.destinationId);
    const createMeta = createMetaReader(projectKey);
    const issueTypes = (await createMeta.issueTypes()).filter(
      issueType => !issueType.subtask
    );
    const requestedIssueType = input.issueType?.trim() ?? '';
    const selectedIssueType =
      issueTypes.find(issueType => issueType.id === requestedIssueType) ??
      (requestedIssueType
        ? issueTypes.find(
            issueType =>
              issueType.name.toLowerCase() ===
              requestedIssueType.toLowerCase()
          )
        : undefined) ??
      issueTypes.find(issueType => issueType.name.toLowerCase() === 'task') ??
      issueTypes[0] ??
      null;
    if (!selectedIssueType) {
      throw new Error(`Jira project ${projectKey} has no available issue types`);
    }
    const fields = await createMeta.fields(selectedIssueType.id);
    const byId = new Map(fields.map(field => [field.fieldId, field]));
    const assigneeField = byId.get('assignee');
    const priorityField = byId.get('priority');
    const assigneeAllowed = (assigneeField?.allowedValues ?? [])
      .map(value => jiraAssignableUserSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const priorityAllowed = (priorityField?.allowedValues ?? [])
      .map(value => jiraNamedIdSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const [fallbackAssignees, labels] = await Promise.all([
      assigneeField
        ? jiraRequest(
            auth,
            `/user/assignable/search?project=${encodeURIComponent(projectKey)}&startAt=0&maxResults=1000`
          )
            .then(payload => jiraAssignableUsersSchema.parse(payload))
            .catch(() => [])
        : Promise.resolve([]),
      byId.has('labels') ? loadLabels().catch(() => []) : Promise.resolve([])
    ]);
    const assignees = [
      ...new Map(
        [...assigneeAllowed, ...fallbackAssignees].flatMap(user => {
          const id = userIdentity(user, deployment);
          return id ? [[id, { id, user }] as const] : [];
        })
      ).values()
    ];
    return {
      statusOptions: [],
      assigneeOptions: assignees
        .filter(entry => entry.user.active !== false)
        .map(entry => ({ id: entry.id, label: entry.user.displayName })),
      priorityOptions: priorityAllowed.map(priority => ({
        id: priority.id,
        label: priority.name
      })),
      labelOptions: labels.map(label => ({ id: label, label })),
      milestoneOptions: [],
      issueTypeOptions: issueTypes.map(issueType => ({
        id: issueType.id,
        label: issueType.name
      })),
      defaultStatusId: null,
      defaultIssueTypeId: selectedIssueType.id,
      supportsDueDate: byId.has('duedate')
    };
  }

  return {
    source: 'jira',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Jira for this BB project in Manage.'
        : rawBaseUrl && !baseUrl
          ? 'Jira URL must be an HTTPS origin without credentials, query, or fragment.'
          : hasCredentials
            ? null
            : isServer
              ? 'Set the Jira URL and Personal Access Token for this BB project in Manage.'
              : 'Set the Jira URL, email, and API token for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Jira is not configured');
      const issues: z.infer<typeof jiraIssueSchema>[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        // The configured ORDER BY is preserved here: it decides which issues
        // land in the first pages. Only scope verification has to drop it.
        // Annotated to break the inference cycle between this closure's
        // inferred return type and the generic searchPage.
        const page: {
          issues: z.infer<typeof jiraIssueSchema>[];
          nextCursor: string | null;
        } = await searchPage(
          options.jql.trim(),
          {
            fields: [
              'summary',
              'description',
              'updated',
              'status',
              'priority',
              'assignee',
              'project',
              'labels'
            ],
            maxResults: 100,
            cursor
          },
          jiraIssueSchema
        );
        issues.push(...page.issues);
        if (!page.nextCursor) break;
        // A repeated cursor means the server is looping us; stop rather than
        // paging forever.
        if (seenCursors.has(page.nextCursor)) {
          throw new Error('Jira returned an invalid pagination token');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      return issues.map(issue => withoutComments(toItem(baseUrl, issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const issue = await loadIssue(locator, {
        comments: true,
        verifyScope: true
      });
      return toItem(baseUrl, issue);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const result = await transitionOptions(locator);
      return result.options.map(
        ({ transitionId: _transitionId, ...option }) => option
      );
    },
    async createMetadata(input) {
      if (!configured) throw new Error('Jira is not configured');
      return createMetadata(input);
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!configured) throw new Error('Jira is not configured');
      const projectKey = assertProjectKey(input.destinationId);
      if (input.statusId !== null) {
        throw new Error('Jira issues are created in the project default status');
      }
      if (input.milestoneId !== null) {
        throw new Error('Jira issues use a due date instead of a milestone');
      }
      if (input.issueType === null) {
        throw new Error('Choose a Jira issue type');
      }
      // Cloud fills reporter from the authenticating token, but Server/DC
      // create screens routinely mark it required, which rejects the whole
      // create. Resolve it before the POST: a failure here is a plain error,
      // whereas a failure inside the POST guard below would be reported as an
      // issue that may already exist.
      const reporter = isServer
        ? await requiredReporterField(projectKey, input.issueType)
        : null;
      let created: z.infer<typeof jiraCreatedIssueSchema>;
      try {
        const payload = await jiraRequest(auth, '/issue', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              summary: input.title,
              issuetype: { id: input.issueType },
              ...(reporter ? { reporter } : {}),
              ...(input.description
                ? {
                    // Cloud's v3 API takes an Atlassian Document Format tree;
                    // Server/DC's v2 description is plain wiki-markup text.
                    description: isServer
                      ? input.description
                      : jiraDescription(input.description)
                  }
                : {}),
              ...(input.assigneeId
                ? {
                    assignee: userFieldValue(input.assigneeId, deployment)
                  }
                : {}),
              ...(input.priorityId
                ? { priority: { id: input.priorityId } }
                : {}),
              ...(input.labelIds.length > 0
                ? { labels: input.labelIds }
                : {}),
              ...(input.dueDate ? { duedate: input.dueDate } : {})
            }
          })
        });
        created = jiraCreatedIssueSchema.parse(payload);
      } catch {
        throw new Error(
          `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
        );
      }
      try {
        const issue = await loadIssue(created.key, {
          comments: false,
          verifyScope: false
        });
        if (issue.id !== created.id || issue.fields.project.key !== projectKey) {
          throw new Error('Jira returned an invalid new issue');
        }
        return {
          item: toItem(baseUrl, issue),
          warnings: [],
          assigneeConfirmation: confirmAssignee(issue.fields.assignee)
        };
      } catch {
        throw new Error(
          `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira created ${created.key}, but Taskboard could not confirm its details. Refresh the board and check for it before trying again.`
        );
      }
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Jira is not configured');
      const available = await transitionOptions(locator);
      const target = available.options.find(option => option.id === statusId);
      if (!target) {
        throw new Error('Jira status is not available for this issue');
      }
      if (!target.current) {
        if (!target.transitionId) {
          throw new Error('Jira status does not have an available transition');
        }
        await jiraRequest(
          auth,
          `/issue/${encodeURIComponent(locator)}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: target.transitionId } })
          }
        );
      }
      const issue = await loadIssue(locator, {
        comments: false,
        verifyScope: false
      });
      if (issue.fields.status.id !== statusId) {
        throw new Error('Jira returned an invalid status update result');
      }
      return toItem(baseUrl, issue);
    }
  };
}
