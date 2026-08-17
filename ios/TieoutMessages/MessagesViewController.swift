import Messages
import SwiftUI
import TieoutCore
import UIKit

/// The approval surface, rendered inline in the Messages thread.
///
/// Text is a poor way to approve forty categorizations. A tappable card in
/// the conversation is the actual product insight, and it is the reason
/// this project targets Messages rather than shipping a chatbot.
///
/// Two constraints shape everything here:
///
///  1. `MSMessage` payloads are size-constrained. The message carries a
///     proposal ID in its URL query and NOTHING else; the detail is fetched
///     from local storage on the other side. Stuffing a proposal into the
///     payload works until a run has four hundred of them.
///
///  2. The extension runs in its own process with its own memory limits, so
///     it stays thin: decode, render, compose. No agent code, no ledger.
final class MessagesViewController: MSMessagesAppViewController {

    private var hosting: UIHostingController<ApprovalListView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        installContent()
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        // Compact is the small tray presentation; there is not enough room
        // to review anything, so ask for the expanded one immediately.
        if presentationStyle == .compact {
            requestPresentationStyle(.expanded)
        }
    }

    private func installContent() {
        let run = Self.loadRun()
        let view = ApprovalListView(run: run) { [weak self] proposal in
            self?.send(proposal)
        }
        let controller = UIHostingController(rootView: view)
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view_installConstraints(controller.view)
        controller.didMove(toParent: self)
        hosting = controller
    }

    private func view_installConstraints(_ child: UIView) {
        self.view.addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            child.topAnchor.constraint(equalTo: view.topAnchor),
            child.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    /// Composes the approval message.
    ///
    /// The layout is what the recipient sees in the thread; the URL is what
    /// the app reads when the card is tapped. Only the identifier travels.
    private func send(_ proposal: ProposalView) {
        guard let conversation = activeConversation else { return }

        var components = URLComponents()
        components.scheme = "tieout"
        components.host = "approve"
        components.queryItems = [
            URLQueryItem(name: "proposal", value: proposal.id),
            URLQueryItem(name: "run", value: Self.loadRun()?.runId ?? ""),
        ]

        let layout = MSMessageTemplateLayout()
        layout.caption = proposal.vendorDescriptor ?? proposal.kind
        layout.subcaption = proposal.amountCents.map { $0.centsFormatted }
        layout.trailingCaption = proposal.glCode
        layout.trailingSubcaption = proposal.glName
        layout.image = Self.cardImage(for: proposal)

        let message = MSMessage(session: conversation.selectedMessage?.session ?? MSSession())
        message.layout = layout
        message.url = components.url
        message.summaryText = "Approve \(proposal.glCode ?? "categorization")"

        conversation.insert(message) { [weak self] error in
            if error == nil {
                Task { @MainActor in self?.dismiss() }
            }
        }
    }

    private static func loadRun() -> CloseRun? {
        // Bundled copy for now. The real version reads a shared container
        // written by the harness — an App Group — which is Phase 6 work.
        guard let url = Bundle.main.url(forResource: "close-run", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? CloseRun.decode(from: data)
    }

    /// A small rendered card so the message reads as a decision rather than
    /// a link. Drawn rather than shipped as an asset so it reflects the
    /// proposal's own confidence and GL code.
    private static func cardImage(for proposal: ProposalView) -> UIImage {
        let size = CGSize(width: 300, height: 160)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemIndigo.withAlphaComponent(0.12).setFill()
            context.fill(CGRect(origin: .zero, size: size))

            let title = proposal.glName ?? "Categorization"
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 20, weight: .semibold),
                .foregroundColor: UIColor.label,
            ]
            title.draw(at: CGPoint(x: 20, y: 28), withAttributes: attributes)

            let subtitle = proposal.rationale
            let subAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 14),
                .foregroundColor: UIColor.secondaryLabel,
            ]
            subtitle.draw(
                with: CGRect(x: 20, y: 62, width: size.width - 40, height: 70),
                options: .usesLineFragmentOrigin,
                attributes: subAttributes,
                context: nil
            )
        }
    }
}
