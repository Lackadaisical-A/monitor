import XCTest

/// Captures the actual app with fictional demo records on a fresh CI simulator.
/// Never sign in or import the private academy roster in this target.
final class AcademyScreenshotTests: XCTestCase {
    @MainActor func testAcademyStoreScreenshots() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--academy-demo", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Ready for takeoff."].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["DEMO"].exists)
        capture(app, "01-today")

        app.buttons["Students"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your students"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Alex Morgan"].exists)
        capture(app, "02-students")

        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Projects in motion"].waitForExistence(timeout: 10))
        capture(app, "03-projects")

        app.buttons["Library"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["The learning library"].waitForExistence(timeout: 10))
        capture(app, "04-skills")

        app.segmentedControls.buttons["Courses"].tap()
        XCTAssertTrue(app.staticTexts["FLT 100"].waitForExistence(timeout: 10))
        capture(app, "05-courses")
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
