import SwiftUI
import TieoutCore

@main
struct TieoutApp: App {
    var body: some Scene {
        WindowGroup {
            RunView(store: RunStore())
        }
    }
}

/// Loads the CloseRun artifact.
///
/// Today it reads the bundled artifact the harness emits. The transport
/// (Phase 6) replaces `load()` and nothing else — the view already renders
/// whatever a `CloseRun` contains, so wiring it to a live run is a change
/// to one function rather than to the UI.
@MainActor
@Observable
final class RunStore {
    enum State {
        case loading
        case loaded(CloseRun)
        case failed(String)
    }

    private(set) var state: State = .loading

    func load() {
        guard let url = Bundle.main.url(forResource: "close-run", withExtension: "json") else {
            state = .failed("close-run.json is not in the app bundle.")
            return
        }
        do {
            let run = try CloseRun.decode(from: Data(contentsOf: url))
            state = .loaded(run)
        } catch {
            state = .failed(String(describing: error))
        }
    }
}
