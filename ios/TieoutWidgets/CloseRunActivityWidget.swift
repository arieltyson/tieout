import ActivityKit
import SwiftUI
import TieoutCore
import WidgetKit

/// The Live Activity for a close run.
///
/// ActivityKit was built for food delivery and rideshares. A month-end
/// close is a genuinely good fit for the same shape: it takes minutes, it
/// has discrete stages, and it ends by needing something from you — which
/// is exactly the thing you should not have to open an app to discover.
struct CloseRunActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TieoutActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Close", systemImage: "book.closed")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.period)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(ActivityCopy.headline(
                        state: context.state.state,
                        pendingApprovals: context.state.pendingApprovals
                    ))
                    .font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        ProgressView(value: context.state.progress)
                            .tint(stateTint(for: context.state.state))
                        HStack {
                            Text(context.state.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(ActivityCopy.summary(
                                findings: context.state.findings,
                                pendingApprovals: context.state.pendingApprovals
                            ))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            } compactLeading: {
                // Sized down and explicitly framed. At the default symbol
                // size the icon rendered CLIPPED IN HALF on an iPhone 17 Pro
                // — the sensor housing squeezes the compact regions harder
                // than the nominal widths suggest. Verified by screenshot,
                // not by eyeballing a preview.
                Image(systemName: "book.closed")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 16)
                    .foregroundStyle(stateTint(for: context.state.state))
            } compactTrailing: {
                // "4/4" lost its leading digit at .caption2. Smaller font,
                // an explicit width, and scaling rather than truncation.
                Text(ActivityCopy.compact(
                    agentsComplete: context.state.agentsComplete,
                    agentsTotal: context.state.agentsTotal
                ))
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .fixedSize()
            } minimal: {
                Image(systemName: context.state.isFinished ? "checkmark" : "book.closed")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(stateTint(for: context.state.state))
            }
            .keylineTint(stateTint(for: context.state.state))
        }
    }
}

private func stateTint(for state: RunState) -> Color {
    switch state {
    case .failed: .red
    case .awaitingApproval: .orange
    case .complete: .green
    default: .blue
    }
}

private struct LockScreenView: View {
    let attributes: TieoutActivityAttributes
    let state: TieoutActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Tieout", systemImage: "book.closed")
                    .font(.caption.weight(.semibold))
                Text(attributes.period)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Text(ActivityCopy.headline(
                    state: state.state,
                    pendingApprovals: state.pendingApprovals
                ))
                .font(.caption.weight(.medium))
                .foregroundStyle(stateTint(for: state.state))
            }

            ProgressView(value: state.progress) {
                EmptyView()
            } currentValueLabel: {
                HStack {
                    Text(state.detail)
                    Spacer()
                    Text("\(state.agentsComplete)/\(state.agentsTotal) agents")
                        .monospacedDigit()
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .tint(stateTint(for: state.state))

            Text(ActivityCopy.summary(
                findings: state.findings,
                pendingApprovals: state.pendingApprovals
            ))
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding()
    }
}
