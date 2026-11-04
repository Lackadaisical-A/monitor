# Academy shared workspace setup

The iPhone app works offline without Airtable or Google API credentials. Real student
names are supplied through a private roster file, never through the app bundle.
Shared sync is disconnected until the following server configuration is completed.

## Google sign-in

1. In Google Cloud Console, create or select an academy-owned project. Configure the
   Google Auth Platform consent screen with the academy name and support contact.
2. Choose the appropriate audience. An internal audience is suitable only when all
   instructors belong to the same Google Workspace organization. For a testing
   external audience, add the intended instructor accounts as test users.
3. Create an OAuth client of type **Web application**. The app uses the server's
   authorization-code flow; an iOS OAuth client or Google Sheets API is not required.
4. Add exactly `https://YOUR-ACADEMY-SERVER/api/academy/v1/auth/callback` as an authorized
   redirect URI. Replace the hostname with the actual deployed server hostname.
5. Save the client ID and client secret in the server's environment secret settings.
   Do not put the client secret in the iPhone app, Git, a roster, or a chat message.

Only `openid email` is requested. The server checks Google's token signature,
issuer, audience, expiry, nonce, verified email, and an explicit staff allowlist.
The native return code is one-use and bound to a verifier generated on the phone.
See Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

## Server configuration

Deploy this branch's Node service with Node 22 or newer and a persistent disk.
Keep the existing service configuration intact; Academy data uses a separate database.

| Environment variable | Value |
| --- | --- |
| `ACADEMY_ORIGIN` | The HTTPS origin, such as `https://academy.example.org`, with no path |
| `ACADEMY_GOOGLE_CLIENT_ID` | The web OAuth client ID |
| `ACADEMY_GOOGLE_CLIENT_SECRET` | The web OAuth client secret, stored as a secret |
| `ACADEMY_DATABASE_PATH` | Persistent path, for example `/app/data/academy.db` |
| `ACADEMY_DATA_KEY` | 32 random bytes encoded as 64 hex characters; generate securely and back it up separately |
| `ACADEMY_STAFF_JSON` | JSON mapping approved email addresses to `admin` or `instructor` |

Example staff mapping (replace these example addresses):

```json
{"director@example.org":"admin","teacher@example.org":"instructor"}
```

Use an administrator for the first import and curriculum edits. Student ranks and
mentor appointments never grant app access. To revoke staff access, remove the email
from this mapping and restart the service; existing sessions are checked against it.
Sessions expire after seven days. Sign-out also invalidates the server session.

Snapshot history is encrypted with AES-256-GCM and retains the authenticated editor
and timestamp. NFC identifiers are stored as keyed digests. Preserve the data key:
losing it makes existing snapshots unreadable. Back up the SQLite database using a
consistent SQLite backup procedure, and keep backups and the key in separate,
access-controlled locations. Set an academy retention policy before live use; this
first version keeps snapshot history rather than automatically deleting it.

## First connection

1. On the director's phone, open **Workspace → Start your academy workspace**.
2. Set the instructor name, then use **Today → Import** to review the private roster
   file. Matching IDs are reused; ambiguous matches with existing records stop the
   import so existing history is not silently merged into the wrong student.
3. Open **Workspace → Shared workspace**, enter the deployed HTTPS origin, and sign
   in with the approved administrator Google account.
4. Tap **Sync now**. Confirm the roster and projects appear on a second approved
   instructor's phone after sign-in and sync.
5. Verify an offline edit, reconnect, and sync. Make different edits on both phones
   to check merging, then change the same field to check the conflict review flow.
6. Test NFC with physical phones. Existing local bindings stay on their original
   phone. Link each passport once while connected to enable server identification
   on other approved phones. NFC never authorizes an assessment.

While the app is open, it attempts sync every 30 seconds. It saves local edits before
network requests. Separate record/field changes merge; competing edits to the same
field require review. Export both copies from the conflict screen before choosing
one when manual reconciliation is needed. This is foreground sync, not a background
push service. A complete local recovery backup is written before applying a shared
or restored snapshot.

## This release's data and teaching content

- 154 source skills/ranks and 608 stable checkpoint IDs; 15 Design lessons use actual
  Onshape workflows. Hardware-specific Atlas, Code, and Pioneer lessons remain
  marked for equipment review before teaching.
- 25 distinct expanded lesson plans, used in 26 course placements: 13 aviation,
  10 aerospace, one CAD lesson shared by two courses, and one BattleBots planning lesson.
  These are instructor-review drafts, not accreditation or flight certification.
- The private roster contains 52 distinct student records and 23 historical class
  groups. Its student source is labeled **Week 6: Oct 19–25, 2026**; it is not treated
  as a current booking feed. November's instructor rota is displayed separately.
- One existing project team could be matched unambiguously to the roster and has
  its source CAD/parts links included. Other project references need identity
  reconciliation; no uncertain student matches or completed assessments were invented.
- Existing app history is preserved separately from the imported skill library.
  Notion student logbook entries are not automatically converted to earned skills.
- Original Notion and Google Sheets documents are unchanged. There is no Airtable
  integration, parent portal, attendance writeback, or automatic parent messaging.

## Validation and deployment boundary

Run `npm run typecheck`, `npm test -- tests/academy.test.ts`, and the `AcademyTests`
Xcode test target before deployment. Automated tests cover authenticated API access,
expiry, role checks, encryption, stale writes, idempotency, NFC uniqueness, curriculum
integrity, assessment gates, backup compatibility, and three-way merge behavior.
Google sign-in and cross-device NFC require a configured live service and real phones;
they cannot be claimed verified from the simulator tests alone.
