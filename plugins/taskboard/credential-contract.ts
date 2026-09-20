import { z } from 'zod';

export const bbProjectIdSchema = z.string().startsWith('proj_');

export const jiraDeploymentSchema = z.enum(['cloud', 'server']);
export type JiraDeployment = z.infer<typeof jiraDeploymentSchema>;

/** True for Atlassian-hosted sites, which are the only ones Cloud auth works against. */
export function isAtlassianCloudHost(hostname: string): boolean {
  return hostname === 'atlassian.net' || hostname.endsWith('.atlassian.net');
}

const JIRA_URL_MESSAGE =
  'Jira URL must be an HTTPS origin without credentials, query, or fragment';

/**
 * Accepts any HTTPS Jira base URL, Cloud or self-hosted. Self-hosted Data
 * Center commonly runs on a non-standard port behind a context path
 * (https://jira.example.com:8443/jira), so both are preserved; the returned
 * value is origin + context path with trailing slashes stripped, ready to be
 * concatenated with a /rest/... path.
 *
 * The Cloud-only host restriction is NOT enforced here because this schema
 * cannot see the configured deployment. It is applied as a cross-field rule
 * once deployment is known -- see projectConfigMutationSchema.
 */
export const jiraBaseUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return '';
    const reject = () => {
      context.addIssue({ code: 'custom', message: JIRA_URL_MESSAGE });
      return z.NEVER;
    };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return reject();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return reject();
    }
    const contextPath = url.pathname.replace(/\/+$/u, '');
    if (contextPath.includes('..')) return reject();
    return `${url.origin}${contextPath}`;
  });

export const secretMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep') }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
  z
    .object({
      operation: z.literal('set'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(16_384)
        .refine(value => !/[\r\n]/u.test(value), {
          message: 'Credential must be a single line'
        })
    })
    .strict()
]);
export type SecretMutation = z.infer<typeof secretMutationSchema>;

export const projectCredentialsInteractionPayloadSchema = z
  .object({
    projectId: bbProjectIdSchema,
    projectName: z.string(),
    linearTeamKey: z.string(),
    jiraBaseUrl: jiraBaseUrlSchema,
    jiraDeployment: jiraDeploymentSchema,
    jiraEmail: z.string(),
    linearCredentialConfigured: z.boolean(),
    jiraCredentialConfigured: z.boolean()
  })
  .strict();
export type ProjectCredentialsInteractionPayload = z.infer<
  typeof projectCredentialsInteractionPayloadSchema
>;

export const projectCredentialsInteractionResponseSchema = z
  .object({
    linearCredential: secretMutationSchema,
    jiraCredential: secretMutationSchema
  })
  .strict();
export type ProjectCredentialsInteractionResponse = z.infer<
  typeof projectCredentialsInteractionResponseSchema
>;
