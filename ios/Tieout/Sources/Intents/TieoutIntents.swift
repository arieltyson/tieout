import AppIntents
import SwiftUI
import TieoutCore

/// Siri, Shortcuts, and Spotlight.
///
/// Worth having for a close specifically. The whole premise is that you
/// should not need to open an app to run one or to find out where it got
/// to, and an intent is the same argument the Live Activity makes, at the
/// other end of the interaction.
///
/// Both intents are read only. There is deliberately no approve intent:
/// approving spend by voice, with no card in front of you and no verifier
/// output visible, is precisely the interaction this project argues
/// against everywhere else.

struct RunCloseIntent: AppIntent {
    static let title: LocalizedStringResource = "Run a close"
    static let description = IntentDescription(
        "Starts a month end close and reports what it found.",
        categoryName: "Accounting"
    )
    /// Opening the app is the honest behaviour: a close takes minutes, and
    /// a result summarised into a Siri response would hide the proposals a
    /// person actually has to look at.
    static let openAppWhenRun = true

    @Parameter(title: "Period", description: "Which month to close, for example 2026-06.")
    var period: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = RunStore()
        store.load()
        guard case let .loaded(run) = store.state else {
            return .result(dialog: "No close is available yet.")
        }
        let text = "\(run.summary.categorized) transactions categorized for \(run.period). "
            + "\(run.summary.needsReview) need a decision."
        return .result(dialog: IntentDialog(stringLiteral: text))
    }
}

struct CheckStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Check close status"
    static let description = IntentDescription(
        "Reports where the current close has got to.",
        categoryName: "Accounting"
    )
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = RunStore()
        store.load()
        guard case let .loaded(run) = store.state else {
            return .result(dialog: "No close is running.")
        }
        return .result(dialog: IntentDialog(stringLiteral: SpokenSummary.text(for: run)))
    }
}

struct TieoutShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CheckStatusIntent(),
            phrases: [
                "Check my \(.applicationName) close",
                "What is my \(.applicationName) status",
            ],
            shortTitle: "Close status",
            systemImageName: "book.closed"
        )
    }
}
