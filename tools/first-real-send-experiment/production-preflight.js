// production-preflight.js — Codex Step 3C-9 repair pass 6, item 8. Extracted from armGate.js.
// READ-ONLY. Contains ONLY the non-mutating ADC/identity/project/database/IAM preflight
// machinery this activation/watchdog/emergency-containment tooling actually needs. Every
// function below performs, at most, authenticated GET/POST calls to Google Cloud metadata/IAM
// endpoints (testIamPermissions, database metadata, project metadata, IAM policy reads, Deny
// policy reads, userinfo) — never a Firestore write, never gate candidate selection, never
// gate creation, never tx.create(), never any Firestore mutation of any kind. This file
// contains NO armGate()/selectCandidate()/verifyFullGateState()/gate-creation logic at all —
// that historical Step 3C-8 source remains OUTSIDE this durable activation package (see the
// prior session's temp scratchpad, or wherever the operator preserves it separately).
//
// Never prints: UID, reminder ID, installation ID, access/refresh/ID tokens, credential file
// contents, the resolved operator email, raw SDK/HTTP error text, or any Firestore document
// path. Prints only: fixed error codes, booleans, counts, and stage labels.
'use strict';

const { CODES, GateOpError } = require('./gateOpErrors');

const { UserRefreshClient, JWT } = require('C:/Users/adamb/neuroactive/functions/node_modules/google-auth-library/build/src/index.js');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const https = require('node:https');

const APP_ID = 'neuroactive-prod';
const PROJECT_ID = 'neuroactive';

// Sourced from this session's own trusted userEmail context (the human operator running this
// entire multi-turn protocol), not guessed. The resolved live identity must equal this
// constant exactly.
const PREAPPROVED_OPERATOR_EMAIL = 'adambruene@gmail.com';

const EMULATOR_ENV_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS'];

function fail(code) {
  throw new GateOpError(code);
}

// =========================================================================================
// SECTION 0 — EMULATOR-ROUTING REJECTION. Runs before any Firestore/firebase-admin client of
// any kind is constructed.
// =========================================================================================
function rejectEmulatorRouting() {
  for (const key of EMULATOR_ENV_VARS) {
    if (process.env[key]) fail(CODES.ADC_EMULATOR_ROUTING_DETECTED);
  }
  console.log('EMULATOR_ROUTING_CHECK: emulator env vars absent =', true);
}

// =========================================================================================
// SECTION 1 — SINGLE-CREDENTIAL ADC BINDING
// =========================================================================================
// GOOGLE_APPLICATION_CREDENTIALS is not an accepted ADC source for this procedure — only the
// well-known gcloud path is legal. This closes the gap where applicationDefault() (used for
// Firebase/Firestore construction, via its own independent discovery) and this file's own
// explicit parse could otherwise silently resolve two DIFFERENT credential files if that
// variable were set between this parse and Firebase construction. Presence of the variable is
// itself a binding-drift condition.
function resolveAdcFilePath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) fail(CODES.ADC_BINDING_DRIFT);
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json');
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

// Windows-normalized, case-insensitive path equality. Never broadened into filesystem ACL
// logic (the owner/ACL proof remains an external execution precondition) — this is purely
// path-string identity.
function windowsPathsEqual(a, b) {
  const norm = (p) => path.normalize(path.resolve(p)).toLowerCase();
  return norm(a) === norm(b);
}

// The security decision for the path ENTRY must never use statSync (which follows symlinks
// silently). lstatSync inspects the entry itself, so a symlink/junction substituted at the
// well-known path is caught here, before realpath is ever consulted.
function lstatRequireOrdinaryNonSymlink(p) {
  let lst;
  try {
    lst = fs.lstatSync(p);
  } catch {
    fail(CODES.ADC_BINDING_DRIFT);
  }
  if (!lst.isFile() || lst.isSymbolicLink()) fail(CODES.ADC_BINDING_DRIFT);
}

// Resolves the well-known ADC path to its OS-canonical form via the native realpath
// implementation, requires that resolution to land back on the SAME expected well-known path
// (never a different target that merely happens to match on content/hash), and re-checks the
// resolved target is itself an ordinary, non-symlink file. Returns the resolved canonical
// path — this, not the unresolved expected string, is what every subsequent ADC read/hash in
// this file uses.
function resolveCanonicalAdcPath(expectedPath) {
  lstatRequireOrdinaryNonSymlink(expectedPath);

  let resolved;
  try {
    resolved = fs.realpathSync.native(expectedPath);
  } catch {
    fail(CODES.ADC_BINDING_DRIFT);
  }
  if (!windowsPathsEqual(resolved, expectedPath)) fail(CODES.ADC_BINDING_DRIFT);

  lstatRequireOrdinaryNonSymlink(resolved);

  return resolved;
}

// Reads and parses the ADC file EXACTLY ONCE, for the entire procedure. The parsed object is
// retained only in memory and passed into the REST auth client (identity, database metadata,
// IAM/Deny, testIamPermissions) — Firebase Admin/Firestore construction does not consume this
// parsed object directly. Also captures, from this SAME single read, the canonical ADC path
// and an initial SHA-256 of the exact bytes read — retained in memory only, never printed —
// used by the ADC binding-context checkpoints that guard applicationDefault()'s own,
// independent ADC discovery against having silently drifted since this parse.
function loadRawAdcCredentialOnce() {
  const expectedAdcPath = resolveAdcFilePath();
  const canonicalAdcPath = resolveCanonicalAdcPath(expectedAdcPath);

  let rawBytes;
  try {
    rawBytes = fs.readFileSync(canonicalAdcPath);
  } catch {
    fail(CODES.ADC_IDENTITY_UNRESOLVED);
  }
  const initialAdcSha256 = createHash('sha256').update(rawBytes).digest('hex');

  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    fail(CODES.ADC_IDENTITY_UNRESOLVED);
  }
  // The well-known-path/applicationDefault() binding proof was established specifically for
  // this project's real ADC shape (authorized_user); service_account is not an accepted type
  // for this procedure's single explicit parse.
  if (parsed.type !== 'authorized_user') fail(CODES.ADC_IDENTITY_UNRESOLVED);
  if (typeof parsed.quota_project_id !== 'string' || parsed.quota_project_id !== PROJECT_ID) fail(CODES.ADC_BINDING_DRIFT);

  return { parsed, canonicalAdcPath, initialAdcSha256 };
}

// Builds the REST-call auth client (implements .request(), auto-attaches the Authorization
// header — never a token in a URL) from the SAME parsed object.
function buildAuthClient(parsed) {
  if (parsed.type === 'authorized_user') {
    if (typeof parsed.client_id !== 'string' || parsed.client_id.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    if (typeof parsed.client_secret !== 'string' || parsed.client_secret.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    return UserRefreshClient.fromJSON(parsed);
  }
  // service_account
  if (typeof parsed.client_email !== 'string' || parsed.client_email.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
  if (typeof parsed.private_key !== 'string' || parsed.private_key.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
  const client = new JWT({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  client.fromJSON(parsed);
  return client;
}

// =========================================================================================
// SECTION 1B — ADC BINDING-CONTEXT CHECKPOINTS
// =========================================================================================
// Rechecks the ADC search-precedence environment AND the full path-entry security decision:
// GOOGLE_APPLICATION_CREDENTIALS still absent, emulator-routing variables still absent, the
// well-known path entry is still an ordinary non-symlink file (lstat, never statSync), its
// native realpath resolution still lands on both the stored canonicalAdcPath AND the
// (freshly reconstructed) expected well-known path under Windows-normalized case-insensitive
// comparison. Never prints any env value or path.
function recheckAdcPathBinding(canonicalAdcPath) {
  for (const key of EMULATOR_ENV_VARS) {
    if (process.env[key]) fail(CODES.ADC_BINDING_DRIFT);
  }
  // resolveAdcFilePath() itself fails ADC_BINDING_DRIFT if GOOGLE_APPLICATION_CREDENTIALS has
  // since appeared.
  const expectedAdcPath = resolveAdcFilePath();
  lstatRequireOrdinaryNonSymlink(expectedAdcPath);

  let resolved;
  try {
    resolved = fs.realpathSync.native(expectedAdcPath);
  } catch {
    fail(CODES.ADC_BINDING_DRIFT);
  }
  if (!windowsPathsEqual(resolved, canonicalAdcPath)) fail(CODES.ADC_BINDING_DRIFT);
  if (!windowsPathsEqual(resolved, expectedAdcPath)) fail(CODES.ADC_BINDING_DRIFT);
}

// Rehashes the exact bytes at canonicalAdcPath and requires exact equality to the hash
// captured at the single initial parse. Never prints the hash, path, or file contents.
function recheckAdcHashUnchanged(canonicalAdcPath, initialAdcSha256) {
  let bytes;
  try {
    bytes = fs.readFileSync(canonicalAdcPath);
  } catch {
    fail(CODES.ADC_BINDING_DRIFT);
  }
  const currentHash = createHash('sha256').update(bytes).digest('hex');
  if (currentHash !== initialAdcSha256) fail(CODES.ADC_BINDING_DRIFT);
}

// Composed checkpoint, reusable at every location the reviewed procedure requires a fresh
// re-verification that the ADC binding context has not drifted since the initial preflight —
// Codex Step 3C-9 repair pass 6, item 4 adds a FOURTH call site (immediately before the
// activation CAS itself) to the three this checkpoint already served under armGate.js.
function performAdcBindingCheckpoint(canonicalAdcPath, initialAdcSha256, label) {
  recheckAdcPathBinding(canonicalAdcPath);
  recheckAdcHashUnchanged(canonicalAdcPath, initialAdcSha256);
  console.log(`ADC_BINDING_CHECKPOINT[${label}]: PASS`);
}

// MINIMAL USERINFO REPAIR (historical, Codex-approved). authClient.request() automatically
// attaches `x-goog-user-project: neuroactive` (because the ADC's quota_project_id is set to
// that value), and Google's userinfo surface rejects that specific header combination with
// 403 for this consumer. This function is a narrow, bounded raw HTTPS call — deliberately NOT
// authClient.request() — sending ONLY Authorization+Accept, to the canonical OIDC endpoint,
// with redirects disabled, a short fixed timeout, and a bounded response size. This is the
// ONLY call in this file that bypasses authClient.request(); every other Google Cloud API call
// below (testIamPermissions, Firestore database metadata, Resource Manager project metadata,
// project IAM policy, both Deny-policy queries) is unchanged and still goes through the normal
// authenticated-client path, x-goog-user-project included.
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const USERINFO_TIMEOUT_MS = 8000;
const USERINFO_MAX_BODY_BYTES = 16 * 1024;

function rawUserinfoGet(bearerToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      USERINFO_URL,
      {
        method: 'GET',
        // Exactly these two headers — deliberately no x-goog-user-project, no other header
        // authClient.request() would otherwise attach.
        headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' },
        timeout: USERINFO_TIMEOUT_MS,
      },
      (res) => {
        // Redirects are never followed — Node's raw https module does not auto-follow; a 3xx
        // response is simply treated as a non-200 failure below, never chased.
        let body = '';
        let bytes = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > USERINFO_MAX_BODY_BYTES) {
            truncated = true;
            req.destroy();
            return;
          }
          body += chunk;
        });
        res.on('end', () => {
          if (truncated) {
            reject(new Error('USERINFO_BODY_TOO_LARGE'));
            return;
          }
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('USERINFO_TIMEOUT'));
    });
    req.on('error', () => reject(new Error('USERINFO_NETWORK_ERROR')));
    req.end();
  });
}

async function resolveAndVerifyPrincipal(authClient) {
  let token = null;
  try {
    let tokenResp;
    try {
      tokenResp = await authClient.getAccessToken();
    } catch {
      fail(CODES.ADC_IDENTITY_UNRESOLVED);
    }
    token = tokenResp.token;
    if (typeof token !== 'string' || token.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);

    let result;
    try {
      result = await rawUserinfoGet(token);
    } catch {
      fail(CODES.ADC_IDENTITY_UNRESOLVED);
    }
    if (result.statusCode !== 200) fail(CODES.ADC_IDENTITY_UNRESOLVED);

    let data;
    try {
      data = JSON.parse(result.body);
    } catch {
      fail(CODES.ADC_IDENTITY_UNRESOLVED);
    }

    const email = data && data.email;
    // The canonical OIDC userinfo endpoint returns `email_verified` as a boolean claim
    // distinct from `email` itself — an email CAN be present while still unverified for this
    // account. Require both.
    const emailVerified = data && data.email_verified;
    if (typeof email !== 'string' || email.length === 0) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    if (emailVerified !== true) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    if (email !== PREAPPROVED_OPERATOR_EMAIL) fail(CODES.ADC_IDENTITY_UNRESOLVED);
    console.log('ADC_IDENTITY_VERIFIED=true');
  } finally {
    token = null; // best-effort clear of the in-memory token reference
  }
}

// Resource Manager's project-level testIamPermissions — the correct call for
// datastore.entities.create (Firestore's own Admin API exposes no resource-level
// testIamPermissions on the database resource; datastore.entities.* permissions are
// project-scoped IAM only).
async function requireDatastoreCreatePermission(authClient) {
  let response;
  try {
    response = await authClient.request({
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:testIamPermissions`,
      method: 'POST',
      data: { permissions: ['datastore.entities.create'] },
    });
  } catch {
    fail(CODES.ADC_PERMISSION_DENIED);
  }
  const granted = Array.isArray(response.data && response.data.permissions) ? response.data.permissions : [];
  if (!granted.includes('datastore.entities.create')) fail(CODES.ADC_PERMISSION_DENIED);
  console.log('ADC_PERMISSION_CHECK: datastore.entities.create granted =', true);
}

// Read-only authenticated Firestore Admin API lookup of the (default) database's metadata,
// using the SAME auth context.
async function requireTargetDatabase(authClient) {
  let response;
  try {
    response = await authClient.request({ url: `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)`, method: 'GET' });
  } catch {
    fail(CODES.ADC_DATABASE_MISMATCH);
  }
  const name = response.data && response.data.name;
  if (name !== `projects/${PROJECT_ID}/databases/(default)`) fail(CODES.ADC_DATABASE_MISMATCH);
  console.log('ADC_DATABASE_CHECK: target is projects/neuroactive/databases/(default) =', true);
}

// Mandatory fresh IAM-drift preflight. Re-establishes, live and read-only, the exact
// trust-fabric facts previously verified: no project parent, operator holds a direct/
// unconditional roles/owner binding, and no project-level IAM Deny policy exists at either the
// project-ID or project-number attachment point.
const PROJECT_NUMBER = '1010503840940';

async function requireNoProjectParent(authClient) {
  let response;
  try {
    response = await authClient.request({ url: `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`, method: 'GET' });
  } catch {
    fail(CODES.IAM_DRIFT_DETECTED);
  }
  // Pin the exact project identity this response describes, not merely trusting the URL we
  // requested — a redirected/mismatched response would otherwise pass the parent-only check
  // below undetected. Project number is checked but never printed in ordinary output.
  if (response.data.projectId !== PROJECT_ID) fail(CODES.IAM_DRIFT_DETECTED);
  if (String(response.data.projectNumber) !== PROJECT_NUMBER) fail(CODES.IAM_DRIFT_DETECTED);
  if (Object.prototype.hasOwnProperty.call(response.data, 'parent') && response.data.parent) {
    fail(CODES.IAM_DRIFT_DETECTED);
  }
}

async function requireOperatorDirectUnconditionalOwner(authClient) {
  let response;
  try {
    response = await authClient.request({ url: `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:getIamPolicy`, method: 'POST', data: {} });
  } catch {
    fail(CODES.IAM_DRIFT_DETECTED);
  }
  const bindings = Array.isArray(response.data && response.data.bindings) ? response.data.bindings : [];
  const ownerBinding = bindings.find((b) => b.role === 'roles/owner');
  if (!ownerBinding) fail(CODES.IAM_DRIFT_DETECTED);
  if (ownerBinding.condition) fail(CODES.IAM_DRIFT_DETECTED); // must be unconditional
  const members = Array.isArray(ownerBinding.members) ? ownerBinding.members : [];
  const hasOperator = members.some((m) => typeof m === 'string' && m.toLowerCase() === `user:${PREAPPROVED_OPERATOR_EMAIL.toLowerCase()}`);
  if (!hasOperator) fail(CODES.IAM_DRIFT_DETECTED);
}

// Exact REST shape: GET https://iam.googleapis.com/v2/policies/{doubly-encoded attachment
// point}/denypolicies. The attachment point identifier itself (e.g.
// "cloudresourcemanager.googleapis.com/projects/neuroactive") is single-URL-encoded, then the
// WHOLE "policies/<that>/denypolicies" path segment is encoded again as it is embedded in the
// request URL.
async function requireNoProjectLevelDenyPolicy(authClient, attachmentSuffix) {
  const attachmentPoint = `cloudresourcemanager.googleapis.com%2Fprojects%2F${attachmentSuffix}`;
  const url = `https://iam.googleapis.com/v2/policies/${encodeURIComponent(attachmentPoint)}/denypolicies`;
  let response;
  try {
    response = await authClient.request({ url, method: 'GET' });
  } catch {
    fail(CODES.IAM_DRIFT_DETECTED);
  }
  const policies = Array.isArray(response.data && response.data.policies) ? response.data.policies : [];
  if (policies.length !== 0) fail(CODES.IAM_DRIFT_DETECTED);
}

async function requireNoIamDrift(authClient) {
  await requireNoProjectParent(authClient);
  await requireOperatorDirectUnconditionalOwner(authClient);
  await requireNoProjectLevelDenyPolicy(authClient, PROJECT_ID); // project-ID attachment
  await requireNoProjectLevelDenyPolicy(authClient, PROJECT_NUMBER); // project-number attachment
  console.log('IAM_DRIFT_CHECK: no parent, operator holds direct unconditional roles/owner, zero project-level Deny policies (both attachment points) =', true);
}

// The full preflight, in strict order: emulator rejection -> single credential load (also
// capturing the ADC binding context) -> auth client built from the SAME parsed object ->
// identity verification (email + email_verified) -> database binding -> IAM-drift
// re-verification -> effective-permission check (mandatory). Returns {authClient,
// canonicalAdcPath, initialAdcSha256} — never the parsed credential object or the resolved
// email — so a caller can perform LATER performAdcBindingCheckpoint() re-verifications (Codex
// Step 3C-9 repair pass 6, item 4) using the SAME already-established binding context, without
// re-parsing ADC from scratch.
async function runPreflight() {
  rejectEmulatorRouting();

  const { parsed, canonicalAdcPath, initialAdcSha256 } = loadRawAdcCredentialOnce();
  // The dedicated runtime worker SA must never be the operator/arming principal for this
  // tooling, even though loadRawAdcCredentialOnce() already enforces type === 'authorized_user'
  // strictly (making this branch currently unreachable) — left in place as defense in depth.
  if (parsed.type === 'service_account' && parsed.client_email === 'notification-delivery-worker@neuroactive.iam.gserviceaccount.com') {
    fail(CODES.ADC_IDENTITY_UNRESOLVED);
  }

  const authClient = buildAuthClient(parsed);

  await resolveAndVerifyPrincipal(authClient);
  await requireTargetDatabase(authClient);
  await requireNoIamDrift(authClient);
  await requireDatastoreCreatePermission(authClient);

  return { authClient, canonicalAdcPath, initialAdcSha256 };
}

module.exports = {
  APP_ID,
  PROJECT_ID,
  runPreflight,
  performAdcBindingCheckpoint,
};
