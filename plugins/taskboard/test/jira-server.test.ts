import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(
        `${specifier.slice(0, -'.js'.length)}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const [{ createJiraAdapter }, { jiraBaseUrlSchema }] = await Promise.all([
  import('../sources/jira.ts'),
  import('../credential-contract.ts')
]);

interface Call {
  url: string;
  method: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

/**
 * Like the Cloud harness in create-metadata.test.ts, but a handler may return
 * { __status } so the legacy-createmeta fallback can be exercised, and every
 * call is recorded with its Authorization header.
 */
async function withMockFetch<T>(
  handler: (url: string, init: RequestInit | undefined) => unknown,
  run: (calls: Call[]) => Promise<T>
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    const result = handler(String(input), init) as Record<string, unknown>;
    const status =
      result && typeof result === 'object' && '__status' in result
        ? Number(result.__status)
        : 200;
    return new Response(status === 200 ? JSON.stringify(result) : '{}', {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function serverAdapter() {
  return createJiraAdapter({
    enabled: true,
    baseUrl: 'https://jira.example.com:8443/jira',
    deployment: 'server' as const,
    email: '',
    apiToken: 'pat-secret',
    jql: 'project = SD ORDER BY updated DESC'
  });
}

function serverFields(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Disk status',
    description: 'plain text from a v2 instance',
    updated: '2026-09-20T22:02:27.000+0200',
    status: { id: 10000, name: 'In queue', statusCategory: { key: 'new' } },
    priority: { name: 'High' },
    assignee: {
      name: 'a.kashin',
      key: 'JIRAUSER24414',
      displayName: 'Aleksandr Kashin'
    },
    project: { key: 'SD', name: 'Service Desk' },
    labels: ['infra'],
    ...overrides
  };
}

function serverIssue(overrides: Record<string, unknown> = {}) {
  return { id: '1757611', key: 'SD-17433', fields: serverFields(), ...overrides };
}

test('base URL schema keeps a self-hosted port and context path', () => {
  assert.equal(
    jiraBaseUrlSchema.parse('https://jira.example.com:8443/jira/'),
    'https://jira.example.com:8443/jira'
  );
  assert.equal(
    jiraBaseUrlSchema.parse('https://team.atlassian.net'),
    'https://team.atlassian.net'
  );
  for (const rejected of [
    'http://jira.example.com',
    'https://user:pass@jira.example.com',
    'https://jira.example.com/?a=b',
    'https://jira.example.com/#x',
    'not a url'
  ]) {
    assert.equal(
      jiraBaseUrlSchema.safeParse(rejected).success,
      false,
      `expected ${rejected} to be rejected`
    );
  }
});

test('Server/DC is configured without an email and authenticates with a PAT', async () => {
  const adapter = serverAdapter();
  assert.equal(adapter.configured(), true);
  assert.equal(adapter.configurationMessage(), null);

  await withMockFetch(
    url => {
      if (url.includes('/search')) {
        return {
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [serverIssue()]
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    async calls => {
      const items = await adapter.list();
      assert.equal(items.length, 1);
      assert.equal(items[0]?.assignee, 'Aleksandr Kashin');
      assert.equal(items[0]?.stateCategory, 'todo');
      assert.equal(
        items[0]?.url,
        'https://jira.example.com:8443/jira/browse/SD-17433'
      );
      assert.equal(
        calls[0]?.url,
        'https://jira.example.com:8443/jira/rest/api/2/search'
      );
      assert.equal(calls[0]?.authorization, 'Bearer pat-secret');
      // The configured ORDER BY must survive into the board query.
      assert.match(String(calls[0]?.body?.jql), /ORDER BY updated DESC$/u);
      assert.equal(calls[0]?.body?.startAt, 0);
    }
  );
});

test('Cloud keeps REST v3 and Basic auth', async () => {
  const adapter = createJiraAdapter({
    enabled: true,
    baseUrl: 'https://team.atlassian.net',
    deployment: 'cloud' as const,
    email: 'me@example.com',
    apiToken: 'cloud-token',
    jql: 'project = ENG'
  });
  await withMockFetch(
    () => ({ issues: [], nextPageToken: null }),
    async calls => {
      await adapter.list();
      assert.equal(
        calls[0]?.url,
        'https://team.atlassian.net/rest/api/3/search/jql'
      );
      assert.match(String(calls[0]?.authorization), /^Basic /u);
    }
  );
});

test('Server/DC pages with startAt until total is reached', async () => {
  const adapter = serverAdapter();
  await withMockFetch(
    (url, init) => {
      if (!url.includes('/search')) throw new Error(`Unexpected: ${url}`);
      const body = JSON.parse(String(init?.body ?? '{}')) as { startAt: number };
      return {
        startAt: body.startAt,
        maxResults: 100,
        total: 3,
        issues:
          body.startAt === 0
            ? [
                serverIssue({ id: '1', key: 'SD-1' }),
                serverIssue({ id: '2', key: 'SD-2' })
              ]
            : [serverIssue({ id: '3', key: 'SD-3' })]
      };
    },
    async calls => {
      const items = await adapter.list();
      assert.deepEqual(
        items.map(item => item.key),
        ['SD-1', 'SD-2', 'SD-3']
      );
      assert.deepEqual(
        calls.map(call => call.body?.startAt),
        [0, 2]
      );
    }
  );
});

test('scope verification drops ORDER BY and rejects issues outside the JQL', async () => {
  const adapter = serverAdapter();
  const scopeJql: string[] = [];

  const inScope = await withMockFetch(
    (url, init) => {
      if (url.includes('/issue/SD-17433?')) return serverIssue();
      if (url.includes('/search')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          jql: string;
          fields: string[];
        };
        scopeJql.push(body.jql);
        assert.deepEqual(body.fields, ['summary']);
        return {
          startAt: 0,
          maxResults: 1,
          total: 1,
          issues: [
            { id: '1757611', key: 'SD-17433', fields: { summary: 'Disk status' } }
          ]
        };
      }
      throw new Error(`Unexpected: ${url}`);
    },
    () => adapter.get('SD-17433')
  );
  assert.equal(inScope.key, 'SD-17433');
  assert.equal(scopeJql[0], '(project = SD) AND issuekey = SD-17433');

  await assert.rejects(
    withMockFetch(
      url => {
        if (url.includes('/issue/SD-17433?')) return serverIssue();
        return { startAt: 0, maxResults: 1, total: 0, issues: [] };
      },
      () => adapter.get('SD-17433')
    ),
    /outside the configured scope/u
  );
});

test('createMetadata falls back to legacy createmeta and maps users by name', async () => {
  const adapter = serverAdapter();
  const metadata = await withMockFetch(
    url => {
      // A pre-9.x Data Center has no per-issue-type createmeta endpoints.
      if (url.includes('/createmeta/')) return { __status: 404 };
      if (url.includes('/createmeta?projectKeys=SD')) {
        return {
          projects: [
            {
              key: 'SD',
              issuetypes: [
                {
                  id: '15704',
                  name: 'Support Task',
                  subtask: false,
                  fields: {
                    summary: { required: true },
                    reporter: { required: true },
                    assignee: { required: false },
                    labels: { required: false }
                  }
                },
                { id: '5', name: 'Sub-task', subtask: true, fields: {} }
              ]
            }
          ]
        };
      }
      if (url.includes('/user/assignable/search?')) {
        return [
          {
            name: 'a.kashin',
            key: 'JIRAUSER24414',
            displayName: 'Aleksandr Kashin',
            active: true
          },
          { displayName: 'No login name' }
        ];
      }
      if (url.includes('/jql/autocompletedata/suggestions?fieldName=labels')) {
        return { results: [{ value: 'infra', displayName: 'infra' }] };
      }
      throw new Error(`Unexpected: ${url}`);
    },
    () => adapter.createMetadata({ destinationId: 'SD', issueType: null })
  );

  assert.deepEqual(metadata.issueTypeOptions, [
    { id: '15704', label: 'Support Task' }
  ]);
  // Only the user carrying a login name is assignable on Server/DC.
  assert.deepEqual(metadata.assigneeOptions, [
    { id: 'a.kashin', label: 'Aleksandr Kashin' }
  ]);
  assert.deepEqual(metadata.labelOptions, [{ id: 'infra', label: 'infra' }]);
  // This create screen exposes neither priority nor a due date.
  assert.deepEqual(metadata.priorityOptions, []);
  assert.equal(metadata.supportsDueDate, false);
});

test('create sends plain text, a name-keyed assignee and a required reporter', async () => {
  const adapter = serverAdapter();
  const created = await withMockFetch(
    (url, init) => {
      if (url.includes('/createmeta/SD/issuetypes/15704?')) {
        // Server/DC pages createmeta under `values`, not Cloud's `fields`.
        return {
          startAt: 0,
          maxResults: 200,
          total: 2,
          isLast: true,
          values: [
            { fieldId: 'reporter', required: true },
            { fieldId: 'assignee', required: false }
          ]
        };
      }
      if (url.endsWith('/rest/api/2/myself')) {
        return { name: 'bot.account', key: 'JIRAUSER1' };
      }
      if (url.endsWith('/rest/api/2/issue') && init?.method === 'POST') {
        return { id: '1757611', key: 'SD-17433' };
      }
      if (url.includes('/issue/SD-17433?')) return serverIssue();
      throw new Error(`Unexpected: ${url}`);
    },
    async calls => {
      const result = await adapter.create({
        title: 'Disk status',
        description: 'line one\nline two',
        destinationId: 'SD',
        issueType: '15704',
        statusId: null,
        assigneeId: 'a.kashin',
        priorityId: null,
        labelIds: ['infra'],
        dueDate: null,
        milestoneId: null
      });
      const post = calls.find(
        call => call.method === 'POST' && call.url.endsWith('/rest/api/2/issue')
      );
      const fields = (post?.body as { fields: Record<string, unknown> }).fields;
      // v2 takes wiki-markup text, not an Atlassian Document Format tree.
      assert.equal(fields.description, 'line one\nline two');
      assert.deepEqual(fields.assignee, { name: 'a.kashin' });
      assert.deepEqual(fields.reporter, { name: 'bot.account' });
      return result;
    }
  );
  assert.equal(created.item.key, 'SD-17433');
  assert.deepEqual(created.assigneeConfirmation, {
    confirmed: true,
    id: 'a.kashin'
  });
});

test('create omits reporter when the create screen does not require it', async () => {
  const adapter = serverAdapter();
  await withMockFetch(
    (url, init) => {
      if (url.includes('/createmeta/SD/issuetypes/15704?')) {
        return {
          startAt: 0,
          maxResults: 200,
          total: 1,
          isLast: true,
          values: [{ fieldId: 'reporter', required: false }]
        };
      }
      if (url.endsWith('/rest/api/2/myself')) {
        throw new Error('caller must not be resolved when reporter is optional');
      }
      if (url.endsWith('/rest/api/2/issue') && init?.method === 'POST') {
        return { id: '1757611', key: 'SD-17433' };
      }
      if (url.includes('/issue/SD-17433?')) return serverIssue();
      throw new Error(`Unexpected: ${url}`);
    },
    async calls => {
      await adapter.create({
        title: 'Disk status',
        description: '',
        destinationId: 'SD',
        issueType: '15704',
        statusId: null,
        assigneeId: null,
        priorityId: null,
        labelIds: [],
        dueDate: null,
        milestoneId: null
      });
      const post = calls.find(
        call => call.method === 'POST' && call.url.endsWith('/rest/api/2/issue')
      );
      const fields = (post?.body as { fields: Record<string, unknown> }).fields;
      assert.equal('reporter' in fields, false);
    }
  );
});

test('updateStatus accepts numeric transition ids from Server/DC', async () => {
  const adapter = serverAdapter();
  const moved = serverFields({
    status: {
      id: 10001,
      name: 'Back to 24/7',
      statusCategory: { key: 'indeterminate' }
    }
  });
  let transitioned = false;
  await withMockFetch(
    (url, init) => {
      if (url.includes('/transitions') && init?.method === 'POST') {
        transitioned = true;
        return {};
      }
      if (url.includes('/transitions')) {
        return {
          transitions: [
            {
              id: 241,
              to: {
                id: 10001,
                name: 'Back to 24/7',
                statusCategory: { key: 'indeterminate' }
              }
            }
          ]
        };
      }
      if (url.includes('/issue/SD-17433?')) {
        return transitioned
          ? serverIssue({ fields: moved })
          : serverIssue();
      }
      if (url.includes('/search')) {
        return { startAt: 0, maxResults: 1, total: 1, issues: [serverIssue()] };
      }
      throw new Error(`Unexpected: ${url}`);
    },
    async calls => {
      const item = await adapter.updateStatus('SD-17433', '10001');
      assert.equal(item.stateCategory, 'in_progress');
      const post = calls.find(
        call => call.method === 'POST' && call.url.includes('/transitions')
      );
      // The numeric id from the wire must be normalized before it is sent back.
      assert.deepEqual(post?.body, { transition: { id: '241' } });
    }
  );
});

test('createMetadata reads the Server/DC `values` page and its label source', async () => {
  const adapter = serverAdapter();
  const metadata = await withMockFetch(
    url => {
      // Shapes below are what Jira Server 8.20 actually returns.
      if (url.includes('/createmeta/SD/issuetypes?')) {
        return {
          startAt: 0,
          maxResults: 200,
          total: 2,
          isLast: true,
          values: [
            { id: '15704', name: 'Support Task', subtask: false },
            { id: '5', name: 'Sub-task', subtask: true }
          ]
        };
      }
      if (url.includes('/createmeta/SD/issuetypes/15704?')) {
        return {
          startAt: 0,
          maxResults: 200,
          total: 2,
          isLast: true,
          values: [
            { fieldId: 'assignee', required: false },
            { fieldId: 'labels', required: false }
          ]
        };
      }
      if (url.includes('/user/assignable/search?')) {
        return [
          {
            name: 'a.kashin',
            key: 'JIRAUSER24414',
            displayName: 'Aleksandr Kashin',
            active: true
          }
        ];
      }
      // Server/DC has no /label; labels come from JQL autocomplete.
      if (url.includes('/jql/autocompletedata/suggestions?fieldName=labels')) {
        return {
          results: [
            { value: 'alpha', displayName: 'alpha' },
            { value: 'stage', displayName: 'stage' },
            { value: 'alpha', displayName: 'alpha' }
          ]
        };
      }
      throw new Error(`Unexpected: ${url}`);
    },
    () => adapter.createMetadata({ destinationId: 'SD', issueType: null })
  );

  assert.deepEqual(metadata.issueTypeOptions, [
    { id: '15704', label: 'Support Task' }
  ]);
  assert.deepEqual(metadata.assigneeOptions, [
    { id: 'a.kashin', label: 'Aleksandr Kashin' }
  ]);
  assert.deepEqual(metadata.labelOptions, [
    { id: 'alpha', label: 'alpha' },
    { id: 'stage', label: 'stage' }
  ]);
});

test('a sign-in redirect is reported as a deployment mismatch, not a dead host', async () => {
  const adapter = createJiraAdapter({
    enabled: true,
    baseUrl: 'https://jira.example.com',
    deployment: 'cloud' as const,
    email: 'me@example.com',
    apiToken: 'cloud-token',
    jql: 'project = SD'
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('', {
      status: 302,
      headers: { location: 'https://jira.example.com/login.jsp' }
    });
  try {
    await assert.rejects(adapter.list(), /Server \/ Data Center/u);
  } finally {
    globalThis.fetch = original;
  }
});

test('an issue whose project omits a requested field does not fail the page', async () => {
  const adapter = serverAdapter();
  await withMockFetch(
    () => ({
      startAt: 0,
      maxResults: 100,
      total: 2,
      issues: [
        serverIssue(),
        // Jira drops a requested field entirely -- not as null -- when the
        // issue's project keeps it off its screens. One such row must not
        // blank the whole board.
        {
          id: '9001',
          key: 'TD-5835',
          fields: {
            summary: 'No priority on this screen',
            description: null,
            updated: '2026-09-20T10:00:00.000+0200',
            status: {
              id: '15903',
              name: 'Reporting',
              statusCategory: { key: 'indeterminate' }
            },
            project: { key: 'TD', name: 'Tech Debt' }
            // priority, assignee and labels are absent, not null
          }
        }
      ]
    }),
    async () => {
      const items = await adapter.list();
      assert.deepEqual(
        items.map(item => item.key),
        ['SD-17433', 'TD-5835']
      );
      const sparse = items[1]!;
      assert.equal(sparse.priority, null);
      assert.equal(sparse.assignee, null);
      assert.deepEqual(sparse.labels, []);
      assert.equal(sparse.stateCategory, 'in_progress');
    }
  );
});
