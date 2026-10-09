import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
const state = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error(
    "Usage: npm run setup --workspace @simurgh/coordinator -- /absolute/private/state /absolute/workspace/dist",
  );
mkdirSync(state, { recursive: true, mode: 0o700 });
const stat = statSync(state);
if (
  (stat.mode & 0o077) !== 0 ||
  (process.getuid && stat.uid !== process.getuid())
)
  throw new Error("Choose an owner-only state directory");
const users = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
].map((user) => ({ ...user, token: randomBytes(32).toString("base64url") }));
const config = {
  origin: "http://127.0.0.1:4317",
  databasePath: join(state, "workspace.sqlite"),
  workspaceDist: process.argv[3] ? resolve(process.argv[3]) : undefined,
  users: users.map(({ id, name, token }) => ({
    id,
    name,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  })),
};
const file = join(state, "coordinator.json");
writeFileSync(file, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(`Private configuration: ${file}`);
console.log("Bootstrap access tokens, displayed only once:");
for (const user of users) console.log(`${user.name}: ${user.token}`);
console.log(
  `Start with SIMURGH_CONFIG=${file} npm run start --workspace @simurgh/coordinator`,
);
