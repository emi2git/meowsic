import XCTest

/// Presses every control in the app on throwaway data. The app is launched
/// with `-uitest` (in-memory database seeded with sheet, chord and score songs)
/// and with cloud sync switched off, so nothing here can reach the real library.
final class MeowsicUITests: XCTestCase {
    private var app: XCUIApplication!

    private static let fixtureScore = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("Fixtures/test-score.musicxml").path

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uitest",
                               "-meowsic.sync.url", "", "-meowsic.sync.key", "", "-meowsic.sync.code", "",
                               "-meowsic.appearance", "system"]
        app.launchEnvironment["MEOWSIC_UITEST_SCORE"] = Self.fixtureScore
        addUIInterruptionMonitor(withDescription: "System permission") { alert in
            for label in ["Allow Full Access", "Allow Access to All Photos", "Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        app.launch()
        // First launch on a fresh simulator: accept the Photos prompt.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Full Access"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        XCTAssertTrue(row("Test Score").waitForExistence(timeout: 30), "seeded songs never appeared")
    }

    override func tearDown() {
        XCTAssertEqual(app.state, .runningForeground, "the app is no longer running — it crashed")
    }

    // MARK: - Helpers

    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    /// A song row's title button in the list.
    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    @discardableResult
    private func tap(_ element: XCUIElement, _ what: String = "", timeout: TimeInterval = 8,
                     file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "missing: \(what.isEmpty ? element.description : what)",
                      file: file, line: line)
        element.tap()
        return element
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    private func assertGone(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let gone = NSPredicate(format: "exists == false")
        let done = XCTWaiter().wait(for: [expectation(for: gone, evaluatedWith: element)], timeout: 8)
        XCTAssertEqual(done, .completed, "\(what) is still on screen", file: file, line: line)
    }

    /// Close a popover (transpose, iPad action sheet) by tapping outside it.
    private func dismissPopover() {
        let region = app.otherElements["PopoverDismissRegion"].firstMatch
        if region.waitForExistence(timeout: 2) { region.tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap() }
    }

    /// Readers close on a vertical swipe; fall back to the Close button.
    private func closeReader(swiping element: XCUIElement) {
        element.swipeDown()
        let more = button("More")
        if more.exists && more.isHittable { tap(button("Close"), "close reader") }
    }

    private func alive(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.state, .runningForeground, "the app crashed", file: file, line: line)
    }

    /// Search field → type → clear, used by several tests to find one row.
    private func search(_ text: String) {
        let field = app.textFields["Search song name"]
        tap(field, "search field")
        field.typeText(text)
    }

    // MARK: - Song list

    func testListSearchSortAndPaging() {
        search("Waltz")
        XCTAssertTrue(row("Test Waltz").waitForExistence(timeout: 5))
        assertGone(row("Amazing Grace"), "a row that doesn't match the search")
        tap(button("Reset view"), "reset view")
        XCTAssertTrue(row("Amazing Grace").waitForExistence(timeout: 5) || row("Filler Song").exists)

        if isPhone {
            tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Date'")).firstMatch, "sort menu")
            tap(button("Title"), "sort by title")
            alive()
        } else {
            for header in ["Title", "Type", "Date", "Pages"] {
                tap(button(header), "\(header) column header")
                tap(button(header), "\(header) column header again")
                alive()
            }
        }
        tap(button("Reset view"), "reset view")

        // Paging: buttons, then swipes.
        tap(button("Next page"), "next page")
        XCTAssertTrue(button("Previous page").isEnabled)
        tap(button("Previous page"), "previous page")
        tap(button("2"), "page 2 button")
        let list = app.windows.firstMatch
        list.swipeRight()
        list.swipeLeft()
        list.swipeRight()
        alive()
    }

    func testTagFilterAndVocabulary() {
        tap(button("Filter by tag"), "tag filter")
        let folk = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Folk ('")).firstMatch
        // New vocabulary tag; then a tag's long-press menu: rename (cancelled) and delete.
        let field = app.textFields["New tag"]
        tap(field, "new tag field")
        field.typeText("Zedtag")
        tap(button("Add"), "add tag")
        if button("Hide keyboard").exists { button("Hide keyboard").tap() }
        let anime = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Anime ('")).firstMatch
        XCTAssertTrue(anime.waitForExistence(timeout: 5))
        anime.press(forDuration: 1.5)
        tap(button("Rename…"), "rename tag")
        tap(app.alerts.buttons["Cancel"], "cancel tag rename")
        anime.press(forDuration: 1.5)
        tap(button("Delete tag"), "delete tag")
        assertGone(anime, "the deleted tag")
        tap(folk, "Folk bubble")
        tap(button("Done"), "close tags")

        XCTAssertTrue(row("Amazing Grace").waitForExistence(timeout: 5))
        assertGone(row("Filler Song 01"), "an untagged row under the Folk filter")
        tap(button("Filter by tag"), "tag filter")
        tap(button("Clear filter"), "clear filter")
        tap(button("Done"), "close tags")
        tap(app.buttons.matching(NSPredicate(format: "label == 'Folk'")).firstMatch, "tag chip in a row")
        tap(button("Reset view"), "reset view")
        alive()
    }

    func testSelectionActions() {
        search("Filler Song 0")
        tap(button("Select songs"), "select mode")
        tap(app.staticTexts["Filler Song 01"], "row 1")
        tap(app.staticTexts["Filler Song 02"], "row 2")
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))

        tap(button("Tags…"), "tags menu")
        tap(button("Add tags…"), "add tags")
        tap(button("Jazz"), "Jazz in the picker")
        tap(button("Add"), "apply tags")
        XCTAssertTrue(button("Jazz").waitForExistence(timeout: 5), "tag chip didn't appear")

        tap(button("Select songs"), "select mode")
        tap(app.staticTexts["Filler Song 01"], "row 1")
        tap(button("Tags…"), "tags menu")
        tap(button("Delete tags…"), "remove tags")
        tap(button("Jazz"), "Jazz in the picker")
        tap(button("Remove"), "apply removal")

        tap(button("Select songs"), "select mode")
        tap(app.staticTexts["Filler Song 03"], "row 3")
        tap(button("Print"), "print")
        XCTAssertTrue(app.navigationBars["Print"].waitForExistence(timeout: 5))
        tap(button("Close"), "close print")

        tap(button("Actions"), "actions menu")
        tap(button("Permanently delete (keep photos)"), "permanent delete")
        tap(app.alerts.buttons["Cancel"], "cancel delete")
        tap(button("Actions"), "actions menu")
        tap(button("Permanently delete and remove photos"), "delete with photos")
        tap(app.alerts.buttons["Cancel"], "cancel delete with photos")
        tap(button("Actions"), "actions menu")
        tap(button("Move to Deleted"), "move to deleted")
        assertGone(row("Filler Song 03"), "the soft-deleted song")

        tap(button("Select songs"), "select mode")
        tap(button("Select all"), "select all")
        tap(button("Cancel"), "leave select mode")
        alive()
    }

    // MARK: - Readers

    func testSheetPager() {
        search("Waltz")
        tap(row("Test Waltz"), "sheet song")
        let pages = app.otherElements["songPages"]
        XCTAssertTrue(pages.waitForExistence(timeout: 8))
        XCTAssertEqual(pages.value as? String, "Page 1 of 3")
        pages.swipeLeft()
        XCTAssertEqual(pages.value as? String, "Page 2 of 3")
        pages.swipeLeft()
        pages.swipeLeft()          // past the end: stays on the last page
        XCTAssertEqual(pages.value as? String, "Page 3 of 3")
        pages.swipeRight()
        XCTAssertEqual(pages.value as? String, "Page 2 of 3")
        pages.pinch(withScale: 2.5, velocity: 2)
        pages.doubleTap()
        alive()

        tap(button("Tags"), "tags")
        tap(button("Cancel"), "cancel tags")
        tap(button("Rename"), "rename")
        tap(button("Cancel"), "cancel rename")
        tap(button("More"), "more menu")
        tap(button("Start new song from this page"), "split song")
        XCTAssertTrue(app.navigationBars["New song"].waitForExistence(timeout: 5))
        tap(button("Cancel"), "cancel new song")
        tap(button("Delete"), "trash")
        XCTAssertTrue(button("Move to Deleted").waitForExistence(timeout: 5))
        if button("Cancel").exists { button("Cancel").tap() } else { dismissPopover() }
        alive()

        closeReader(swiping: pages)   // vertical swipe closes the viewer
        XCTAssertTrue(row("Test Waltz").waitForExistence(timeout: 5))

        // Rename for real, then split and unmerge.
        tap(row("Test Waltz"), "sheet song")
        tap(button("Rename"), "rename")
        let title = app.textFields.firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.typeText(" Two")
        tap(button("Save"), "save rename")
        tap(button("More"), "more menu")
        tap(button("Unmerge pages"), "unmerge")
        tap(button("Reset view"), "reset view")
        alive()
    }

    func testChordReader() {
        search("Amazing")
        tap(row("Amazing Grace"), "chord song")
        XCTAssertTrue(button("Larger text").waitForExistence(timeout: 8))
        let window = app.windows.firstMatch
        window.swipeLeft()
        window.swipeRight()
        tap(button("Larger text"), "larger text")
        tap(button("Larger text"), "larger text")
        tap(button("Smaller text"), "smaller text")
        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Transpose'")).firstMatch, "transpose")
        tap(button("Transpose up"), "transpose up")
        tap(button("Transpose up"), "transpose up")
        tap(button("Transpose down"), "transpose down")
        tap(button("Reset"), "transpose reset")
        dismissPopover()

        tap(button("More"), "more menu")
        tap(button("Rename…"), "rename")
        tap(app.alerts.buttons["Cancel"], "cancel rename")
        tap(button("More"), "more menu")
        tap(button("Tags…"), "tags")
        tap(button("Cancel"), "cancel tags")
        tap(button("More"), "more menu")
        tap(button("Edit chord text…"), "edit")
        XCTAssertTrue(app.navigationBars["Edit chord"].waitForExistence(timeout: 5))
        tap(button("Cancel"), "cancel edit")
        tap(button("More"), "more menu")
        tap(button("Delete"), "delete")
        tap(app.alerts.buttons["Cancel"], "cancel delete")
        alive()

        closeReader(swiping: window)   // vertical swipe closes the reader
        XCTAssertTrue(row("Amazing Grace").waitForExistence(timeout: 5))
    }

    func testScoreReader() {
        search("Test Score")
        tap(row("Test Score"), "score song")
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15), "notation never appeared")
        let play = button("Play")
        XCTAssertTrue(play.waitForExistence(timeout: 15), "no Play button — the MIDI wasn't attached")

        tap(button("Larger notes"), "zoom in")
        tap(button("Smaller notes"), "zoom out")

        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Transpose'")).firstMatch, "transpose")
        tap(button("Transpose up"), "transpose up")
        tap(button("Transpose up"), "transpose up")
        XCTAssertTrue(app.staticTexts["+2"].firstMatch.waitForExistence(timeout: 5))
        tap(button("Transpose down"), "transpose down")
        tap(button("Reset"), "transpose reset")
        dismissPopover()

        tap(play, "play")
        XCTAssertTrue(button("Pause").waitForExistence(timeout: 10), "playback didn't start")
        sleep(3)
        tap(button("Pause"), "pause")
        XCTAssertTrue(button("Play").waitForExistence(timeout: 5))
        app.webViews.firstMatch.swipeUp()
        app.webViews.firstMatch.swipeDown()

        tap(button("More"), "more menu")
        tap(button("Rename…"), "rename")
        tap(app.alerts.buttons["Cancel"], "cancel rename")
        tap(button("More"), "more menu")
        tap(button("Tags…"), "tags")
        tap(button("Cancel"), "cancel tags")
        tap(button("More"), "more menu")
        tap(button("Delete"), "delete")
        tap(button("Move to Deleted"), "move to deleted")
        assertGone(app.webViews.firstMatch, "the score reader")
        alive()
    }

    // MARK: - Settings and adding

    func testSettings() {
        tap(button("Settings"), "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        tap(button("Practice stats & fun facts"), "stats")
        XCTAssertTrue(app.navigationBars["Stats"].waitForExistence(timeout: 5))
        app.swipeUp()
        tap(app.navigationBars["Stats"].buttons.firstMatch, "back")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        for theme in ["Dark", "Light", "System"] { tap(button(theme), "\(theme) theme") }
        app.swipeUp()
        XCTAssertTrue(button("Back up to cloud").waitForExistence(timeout: 5))
        XCTAssertFalse(button("Back up to cloud").isEnabled, "cloud sync must be off during tests")
        app.swipeUp()
        tap(button("Import database"), "import database")
        tap(app.alerts.buttons["Cancel"], "cancel import")
        tap(button("Export database"), "export database")
        alive()
        // The system save panel: leave it.
        for label in ["Cancel", "Close"] where button(label).waitForExistence(timeout: 4) { button(label).tap(); break }
        app.swipeDown()
        tap(button("Done"), "close settings")
        alive()
    }

    func testAddSheetMenuAndAddChord() {
        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Sheet' OR identifier == 'photo.badge.plus'")).firstMatch, "add sheet menu")
        tap(button("Auto Scan"), "auto scan")
        let scan = app.alerts["Auto Scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20))
        for label in ["Cancel", "OK"] where scan.buttons[label].exists { scan.buttons[label].tap(); break }

        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Sheet' OR identifier == 'photo.badge.plus'")).firstMatch, "add sheet menu")
        tap(button("Import score (MusicXML, MIDI)…"), "import score")
        sleep(2)
        alive()
        for label in ["Cancel", "Close"] where button(label).waitForExistence(timeout: 4) { button(label).tap(); break }

        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Sheet' OR identifier == 'photo.badge.plus'")).firstMatch, "add sheet menu")
        tap(button("Pick photos…"), "pick photos")
        sleep(2)
        alive()
        for label in ["Cancel", "Close"] where button(label).waitForExistence(timeout: 4) { button(label).tap(); break }

        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Chord' OR identifier == 'music.note'")).firstMatch, "add chord")
        XCTAssertTrue(app.navigationBars["Add Chord"].waitForExistence(timeout: 5))
        let title = app.textFields["Song title"]
        if !title.exists {
            tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Language'")).firstMatch, "language switch")
        }
        tap(title, "title field")
        title.typeText("Brand New Chord")
        let editor = app.textViews.firstMatch
        tap(editor, "chord text")
        // Focusing the editor offers to paste the clipboard; iOS asks first. Decline.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let decline = springboard.buttons["Don’t Allow Paste"]
        if decline.waitForExistence(timeout: 4) { decline.tap() }
        editor.typeText("C G Am F")
        tap(button("Save"), "save chord")
        XCTAssertTrue(row("Brand New Chord").waitForExistence(timeout: 8))
        alive()
    }
}
