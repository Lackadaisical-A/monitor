# Instructor hours · build 22

Open **Today → My hours** (also available in Workspace). Sign in with an individual instructor code or NFC card and use the academy workspace. Demo mode cannot record hours.

**Check in & start hours** requests a fresh precise location while the app is open. The server accepts a reported position within **100 feet / 30.48 meters** of the academy pin, with horizontal accuracy of 20 meters or better and a fix no more than 30 seconds old (10 seconds of future clock tolerance). Software-simulated fixes and approximate location are rejected. The app waits up to 25 seconds for a suitable fix; it stops location services after success, failure, or cancellation.

The starting pin is **40.741872424605, -74.051032864512**, the Esri World Geocoding PointAddress result for **118 Ferry St, Jersey City, NJ 07307**, retrieved November 7, 2026. The Census address-range match is about 18 meters away and supports the same street location. Do not use the academy website's JSON-LD point (40.7234, -74.0468), which points elsewhere.

Sources:

- [Address point lookup](https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?SingleLine=118%20Ferry%20Street%2C%20Jersey%20City%2C%20NJ%2007307&f=json&outFields=Match_addr%2CAddr_type&maxLocations=1)
- [Census address-range lookup](https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=118%20Ferry%20Street%20Jersey%20City%20NJ%2007307&benchmark=Public_AR_Current&format=json)

An administrator should open **Verify entrance pin & radius** while standing at the actual entrance before the first classroom rollout. A precise, non-simulated fix within 60 meters of the address point is required to calibrate the pin. Radius options are 100, 150, and 200 feet; the initial setting is 100. Pin changes are versioned and audited. Changing the pin does not rewrite previous verification records. GPS is an estimate, especially indoors; this is a practical location check, not tamper-proof presence verification. The backend rejects invalid, old, or outside fixes, but a modified client can falsify device claims.

**Clock out** is allowed from anywhere without a location request. Both actions require online server confirmation. Times come from the server, not editable phone fields. An open shift persists across app and server restarts. Hours never stop automatically; shifts open longer than 16 hours are flagged in the app for review. If a connection fails after an action, refresh hours before trying again. Request IDs and a unique open-shift constraint prevent duplicate time records.

Weeks run Monday–Sunday in **America/New_York**, including daylight-saving transitions. Completed totals exclude open shifts and clip shifts crossing a week boundary to the selected week. Administrators can select **Team hours**, export the selected week, and add missed shifts or correct existing ones. A reason is required, prior times and the editor are retained, future/overlapping entries are rejected, and corrections require the current record version. Manual entries are labeled separately from location-checked clock-ins. This records work time; it does not calculate wages, overtime, or break deductions.

## Storage and access

Hours use separate tables in the existing Render SQLite database: `academy_hours`, `academy_hours_operations`, `academy_hours_site`, and `academy_hours_site_audit`. New tables are created automatically at startup. Shift content and site history are encrypted with the existing data key. Lookup columns contain staff account IDs and timestamps. No extra Render service or API key is needed.

The raw clock-in coordinates are evaluated and discarded. Retained verification consists of distance, reported accuracy, radius, and pin revision. There is no background tracking and no clock-out location request. The workplace entrance coordinate itself is retained as shared configuration. Instructors can access only their own shifts; administrators can access team shifts. Family tokens and student passports grant no access. Hours are outside workspace synchronization and JSON backups, so an old app cannot erase them by syncing a student roster.

## Validation and release

Run `npm run typecheck`, `npm test -- tests/academy.test.ts tests/academy-journal.test.ts tests/academy-hours.test.ts`, and the `AcademyTests` iOS scheme. The release workflow includes these tests and the new location usage string/privacy declaration.

Before use on a real iPhone, verify: allow/deny/approximate location states; accurate inside/outside fixes at the real entrance; retry near a window; clock-out after leaving; loss of connectivity; a second device showing the same open shift; and admin correction/history. Simulators intentionally cannot clock into the real service. App Store privacy answers must reflect location use before a future public App Store release.
