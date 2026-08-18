import SwiftUI

/// What the extension draws: the proposals a human actually has to decide.
///
/// High-confidence items are batched behind a single control because
/// reviewing four hundred cards one at a time is not review, it is
/// rubber-stamping. Anything blocked by a verifier is shown but cannot be
/// approved — a deterministic failure is a fact, and a human should not be
/// invited to wave it through.
public struct ApprovalListView: View {
    let run: CloseRun?
    let onApprove: ((ProposalView) -> Void)?

    /// `onApprove` is nil when the surface is being shown for review rather
    /// than composition — the app can display the same cards the Messages
    /// extension does without offering to insert a message.
    public init(run: CloseRun?, onApprove: ((ProposalView) -> Void)? = nil) {
        self.run = run
        self.onApprove = onApprove
    }

    public var body: some View {
        NavigationStack {
            Group {
                if let run {
                    content(for: run)
                } else {
                    ContentUnavailableView(
                        "No run available",
                        systemImage: "tray",
                        description: Text("Start a close from the Tieout app.")
                    )
                }
            }
            .navigationTitle("Approvals")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
    }

    @ViewBuilder
    private func content(for run: CloseRun) -> some View {
        List {
            Section {
                SummaryHeader(run: run)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            // Above the categorizations on purpose. A duplicate charge is
            // worth more of a reviewer's attention than whether a software
            // subscription landed in marketing, and the order of the screen
            // is the only thing that says so.
            if !run.findingsNeedingJudgement.isEmpty {
                Section {
                    ForEach(run.findingsNeedingJudgement) { finding in
                        FindingCard(finding: finding)
                    }
                } header: {
                    Label("Judgement calls", systemImage: "questionmark.circle")
                } footer: {
                    Text("No arithmetic settles these. The model reached a view and a person confirms it.")
                }
            }

            let settled = run.findings.filter { !$0.needsJudgement }
            if !settled.isEmpty {
                Section {
                    ForEach(settled.prefix(12)) { finding in
                        FindingCard(finding: finding)
                    }
                } header: {
                    Label("Found by arithmetic", systemImage: "function")
                } footer: {
                    Text("\(settled.count) exceptions computed exactly. Shown for the record, not for approval.")
                }
            }

            if !run.blockedProposals.isEmpty {
                Section {
                    ForEach(run.blockedProposals.prefix(20)) { proposal in
                        ApprovalCard(proposal: proposal, onApprove: nil)
                    }
                } header: {
                    Label("Blocked by the verifier bank", systemImage: "xmark.octagon")
                } footer: {
                    Text("Deterministic failures cannot be approved. They go back to the agent to repair.")
                }
            }

            Section {
                ForEach(reviewable(run).prefix(20)) { proposal in
                    ApprovalCard(proposal: proposal, onApprove: onApprove)
                }
            } header: {
                // Saying "needs a decision" above a sample the model was
                // confident about contradicts the "0 need review" line
                // directly above it. Name which list this actually is.
                Text(run.needsReviewProposals.isEmpty ? "Spot check" : "Needs a decision")
            } footer: {
                if onApprove == nil {
                    Text(run.needsReviewProposals.isEmpty
                         ? "Nothing was flagged uncertain. A sample is shown anyway — a run nobody looks at is a run nobody trusts. Approve from the Messages extension."
                         : "Approve from the Messages extension.")
                } else {
                    Text("Approving inserts a card into the thread carrying only the proposal ID.")
                }
            }
        }
    }

    private func reviewable(_ run: CloseRun) -> [ProposalView] {
        let uncertain = run.needsReviewProposals
        // A run where the model was confident about everything still needs
        // a sample in front of a human before it is trusted.
        return uncertain.isEmpty ? Array(run.proposals.filter { !$0.isBlocked }.prefix(5)) : uncertain
    }
}

private struct SummaryHeader: View {
    let run: CloseRun

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(run.period)
                    .font(.title2.weight(.semibold))
                Spacer()
                Text("\(run.summary.categorized) categorized")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("\(run.summary.blocked) blocked · \(run.summary.needsReview) need review · \(run.findings.count) findings")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private struct FindingCard: View {
    let finding: FindingView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(finding.kind.humanizedKind)
                    .font(.subheadline.weight(.medium))
                Spacer()
                if let cents = finding.materialityCents {
                    Text(cents.centsFormatted)
                        .font(.subheadline.monospacedDigit())
                }
            }
            Text(finding.summary)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if !finding.txnIds.isEmpty {
                Text(finding.txnIds.prefix(4).joined(separator: ", ")
                     + (finding.txnIds.count > 4 ? " +\(finding.txnIds.count - 4) more" : ""))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

extension String {
    /// `bankAmountMismatch` reads as "Bank amount mismatch" rather than as a
    /// field name that leaked onto the screen.
    var humanizedKind: String {
        var out = ""
        for character in self {
            if character.isUppercase, !out.isEmpty {
                out.append(" ")
                out.append(Character(character.lowercased()))
            } else {
                out.append(character)
            }
        }
        return out.prefix(1).uppercased() + out.dropFirst()
    }
}

private struct ApprovalCard: View {
    let proposal: ProposalView
    /// `nil` means this proposal cannot be approved from here.
    let onApprove: ((ProposalView) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(proposal.vendorDescriptor ?? proposal.kind)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer()
                if let cents = proposal.amountCents {
                    Text(cents.centsFormatted)
                        .font(.subheadline.monospacedDigit())
                }
            }

            if let code = proposal.glCode, let name = proposal.glName {
                Text("\(code) · \(name)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(proposal.rationale)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            HStack {
                if let blockedBy = proposal.blockedBy {
                    Label(blockedBy, systemImage: "xmark.octagon.fill")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.red)
                } else {
                    ConfidenceBadge(confidence: proposal.confidence)
                }
                Spacer()
                if let onApprove {
                    Button("Approve") { onApprove(proposal) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ConfidenceBadge: View {
    let confidence: Confidence

    var body: some View {
        Text(confidence.rawValue)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
    }

    private var tint: Color {
        switch confidence {
        case .high: .green
        case .medium: .orange
        case .low: .red
        }
    }
}
