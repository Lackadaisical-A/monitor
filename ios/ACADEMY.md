# Flight Academy for iPhone

The native entrypoint now opens the Academy workspace. It no longer starts the stock monitor, StoreKit subscriptions, club attendance, or stock notification registration. The bundle identifier and target remain unchanged so this can update the existing app. Legacy source and backend records are retained.

## Build and test

```sh
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/BiotechSignal.xcodeproj -scheme BiotechSignal \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/BiotechSignal.xcodeproj -scheme BiotechSignal \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  CODE_SIGNING_ALLOWED=NO test
```

Open `ios/BiotechSignal.xcodeproj` in Xcode to run on a device. The display name is **Flight Academy**; the target and scheme remain `BiotechSignal` for signing continuity.

## First launch

The first launch opens a labeled demo with three fictional students. **Workspace → Start your academy workspace** creates an empty, separate roster. Add an instructor name before recording real work. Both workspaces persist independently.

The app includes a native Flight Deck, student passports, phase-based skill map, students, course plans, and logbooks. Its draft curriculum contains 74 editable cards, 250 checkride skills, and 15 courses from the supplied October 30, 2026 Ability System snapshot. FLT, UAS, and ENG course codes are preserved; Robotics is presented as Engineering.

Edit cards in the skill map, including prerequisites, mission, track, phase, and checklists. Edit course sessions and their linked cards through Courses. Invalid references and prerequisite cycles are rejected. Changing a checklist resets unfinished checklists while preserving signed evidence in the logbook.

One card can be in progress per student. Every skill must be demonstrated before instructor sign-off. Safety clearances can be paused/restored with a reason; a paused clearance blocks downstream work through the complete prerequisite chain. Cadet, Mission Specialist, and Pilot follow the draft's card requirements. Leadership ranks are described as requiring human review rather than awarded automatically.

## NFC and instructor authorization

Link a tag in a student's passport. A scan opens the student; a passport-verified checkride checks the scanned tag against the selected student. Manual sign-off is also available. Live sign-offs and passport linking require device-owner authentication; the iPhone must have a passcode. Demo mode skips that authorization gate.

Raw NFC identifiers are never persisted. The app stores HMAC-SHA256 fingerprints with a separate Keychain key. A tag identifies the student and never authorizes a sign-off. Replacing a tag removes the old association. Offline instructor names are local audit labels. Shared workspace accounts are verified by the Render service using private instructor codes or linked instructor NFC credentials; staff access is independent of student ranks.

Core NFC cannot run in the simulator. Validate the intended tags, wrong-student rejection, duplicate-tag handling, device authentication, and backup recovery on a signed physical iPhone before classroom use.

## Storage and backups

The app works offline and can synchronize a shared Academy workspace through Render. Academy snapshots use a separate encrypted SQLite database on the existing persistent disk; legacy service data stays separate. Approved staff sign in using individual access codes. No club records are migrated.

Workspaces use atomic, device-protected JSON files under Application Support/FlightAcademy: `demo.json` and `academy.json`. Logbook entries can be exported as text. JSON workspace backups contain student names and educational records, so store them privately. They omit NFC fingerprints; tags must be re-linked after restoring. Restore validates the file first and saves the previous records to `*-before-restore.json`. Portable backups are not tamper-evident credentials.

Build 20 adds instructor access-code sign-in, NFC card writing and tap sign-in, plus a prefilled Render server address. The private roster is already loaded on the shared server. Use **Workspace → Shared workspace**, switch out of the demo, and sign in. Foreground sync runs every 30 seconds. Conflicting edits require review. See [shared-workspace setup](../docs/academy-shared-workspace.md) for access, revocation, backups, and physical NFC checks.

## Validation and release scope

`AcademyTests` covers curriculum integrity, prerequisites, single-card progression, complete checkrides, duplicate prevention, transitive clearance gates, rank criteria, and backup round trips.

The Academy release uses version 2.1 and the existing app identity. The upload workflow on `codex/academy-instructor-2-1` builds with Xcode 26.6, verifies NFC signing, uploads to App Store Connect, waits for processing, and assigns the build to the existing internal TestFlight group. The workflow also adds the build to the existing external TestFlight group and submits beta review when required. It does not submit a public App Store release or notify external testers. The native privacy manifest reflects shared academy records. The dedicated Academy privacy page is `/academy-privacy.html`; the existing web dashboard remains separate.

## Sources and assets

- [Academy brand](https://flightaerospace.academy/): B612 headings, navy `#0E2A47`, white, and curriculum gold.
- [Ability System draft](https://claude.ai/artifact/VGNacUrUm6zrzghnHVTobi#map): public read-only snapshot, not live student data.
- The Instagram reference was not readable with the available web fetch; the ability/NFC workflow follows the supplied prototype.
- B612 is bundled for offline use under `BiotechSignal/Academy/Resources/B612-OFL.txt`.
- Regenerate the vector-drawn icon from the repository root with `swift scripts/generate-academy-icon.swift`.

Build 21 adds dated class logbooks, per-student progress notes, camera/photo-library attachments, and revocable private family links. Open Today → Class logbook, or view a student’s class updates from their profile. Photos are encrypted on Render and cached with device protection. JSON backups contain photo references, not photo binaries.
