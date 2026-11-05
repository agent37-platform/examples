// The Neon calls this example makes, through the official SDK (@neon/sdk).
// Reference: https://neon.com/docs/reference/typescript-sdk
import { createNeonClient } from '@neon/sdk';
import { neon as neonSql } from '@neondatabase/serverless';

// throwOnError turns every failed call into a thrown NeonError (with `kind`, `status`,
// and `message`), so the server's one error handler covers them. The SDK also retries
// 423 Locked, which several branches created off one parent at once can hit, and polls
// creates until their compute is ready.
const client = createNeonClient({
  apiKey: process.env.NEON_API_KEY,
  // Needed with a personal API key; an organization API key implies it.
  orgId: process.env.NEON_ORG_ID || undefined,
  throwOnError: true,
});

const REGION = process.env.NEON_REGION || 'aws-us-east-2';

// One Neon project per agent. Its default branch is the agent's database.
export async function createProject(name) {
  const { project, connectionString } = await client.projects.createAndConnect({ name, region_id: REGION, pooled: true });
  const branch = await client.branches.getDefault({ projectId: project.id });
  return { projectId: project.id, branchId: branch.id, connectionString };
}

export const deleteProject = (projectId) => client.projects.delete({ projectId });

// A branch is a copy-on-write copy of its parent's data at this moment: instant,
// whatever the database size. createAndConnect adds a read-write compute, waits until it
// is ready, and returns its pooled connection string.
//
// A new branch keeps its parent's role passwords, so that string would also log in to
// the parent's endpoint: an attempt could write to the original just by changing the
// host. Resetting the role's password on the new branch gives it a credential of its own;
// the parent's password is untouched and no longer works on the branch.
export async function createBranch(projectId, parentId, name) {
  const created = await client.branches.createAndConnect({ projectId, parentId, name, pooled: true });
  const roleName = new URL(created.connectionString).username;
  await client.postgres.roles.resetPassword({ projectId, branchId: created.branch.id, roleName }, { waitForReadiness: true });
  return { branchId: created.branch.id, connectionString: await connectionString(projectId, created.branch.id) };
}

// Neon will not delete a branch that has children, or a project's default branch.
export const deleteBranch = (projectId, branchId) => client.branches.delete({ projectId, branchId });

export const setDefaultBranch = (projectId, branchId) => client.branches.setDefault({ projectId, branchId });

// The database and role are picked automatically when the branch has exactly one.
export const connectionString = (projectId, branchId) => client.postgres.connectionString({ projectId, branchId, pooled: true });

// Run one statement in a READ ONLY transaction over Neon's HTTP driver, so a check query
// can read a branch but can't write to it.
export async function readOnlyQuery(uri, text) {
  const sql = neonSql(uri);
  const [rows] = await sql.transaction([sql.query(text)], { readOnly: true });
  return rows;
}
