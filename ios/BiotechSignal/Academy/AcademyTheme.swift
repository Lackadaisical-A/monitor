import SwiftUI

enum AcademyTheme {
    static let navy = Color(red: 14 / 255, green: 42 / 255, blue: 71 / 255)
    static let ink = Color(red: 17 / 255, green: 33 / 255, blue: 49 / 255)
    static let muted = Color(red: 92 / 255, green: 107 / 255, blue: 122 / 255)
    static let paper = Color(red: 246 / 255, green: 247 / 255, blue: 249 / 255)
    static let line = Color(red: 225 / 255, green: 230 / 255, blue: 235 / 255)
    static let gold = Color(red: 229 / 255, green: 202 / 255, blue: 118 / 255)
    static let goldInk = Color(red: 116 / 255, green: 88 / 255, blue: 22 / 255)
    static let blue = Color(red: 48 / 255, green: 101 / 255, blue: 147 / 255)
    static let green = Color(red: 36 / 255, green: 112 / 255, blue: 89 / 255)
    static func display(_ size: CGFloat, bold: Bool = true, relativeTo: Font.TextStyle = .title) -> Font {
        .custom(bold ? "B612-Bold" : "B612-Regular", size: size, relativeTo: relativeTo)
    }
}

struct AcademyEyebrow: View {
    var text: String
    var color: Color = AcademyTheme.muted
    var body: some View { Text(text.uppercased()).font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.5).foregroundStyle(color) }
}

struct AcademyPrimaryButton: ButtonStyle {
    var gold = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 16)
            .foregroundStyle(gold ? AcademyTheme.navy : .white)
            .background(gold ? AcademyTheme.gold : AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 13))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
    }
}

struct AcademyPanel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { content.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(.white, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(AcademyTheme.line, lineWidth: 1)) }
}

struct AcademyPill: View {
    let text: String
    var color: Color = AcademyTheme.navy
    var body: some View { Text(text).font(.system(size: 10, weight: .semibold)).padding(.horizontal, 9).padding(.vertical, 5).foregroundStyle(color).background(color.opacity(0.08), in: Capsule()) }
}

struct AcademyAvatar: View {
    let student: AcademyStudent
    var size: CGFloat = 42
    var dark = false
    var body: some View {
        Text(student.initials).font(AcademyTheme.display(size * 0.33)).frame(width: size, height: size)
            .foregroundStyle(dark ? AcademyTheme.gold : AcademyTheme.navy)
            .background(dark ? Color.white.opacity(0.09) : AcademyTheme.navy.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.28))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28).stroke(dark ? .white.opacity(0.16) : AcademyTheme.line, lineWidth: 1)).accessibilityHidden(true)
    }
}

struct AcademyEmpty: View {
    let symbol: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 15) {
            Image(systemName: symbol).font(.system(size: 36, weight: .light)).foregroundStyle(AcademyTheme.blue).padding(22).background(.white, in: Circle())
            Text(title).font(AcademyTheme.display(22)).foregroundStyle(AcademyTheme.navy)
            Text(message).font(.subheadline).foregroundStyle(AcademyTheme.muted).multilineTextAlignment(.center).lineSpacing(4)
        }.frame(maxWidth: .infinity).padding(.vertical, 38)
    }
}

struct AcademyFlightDrawing: View {
    var body: some View {
        Canvas { context, size in
            var grid = Path()
            for x in stride(from: 0.0, through: size.width, by: 26) { grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height)) }
            for y in stride(from: 0.0, through: size.height, by: 26) { grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y)) }
            context.stroke(grid, with: .color(.white.opacity(0.045)), lineWidth: 0.5)
            let center = CGPoint(x: size.width * 0.88, y: size.height * 0.45)
            for radius in [48.0, 75.0, 102.0] {
                context.stroke(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)), with: .color(.white.opacity(0.1)), style: StrokeStyle(lineWidth: 0.7, dash: radius == 75 ? [3, 5] : []))
            }
            var route = Path(); route.move(to: CGPoint(x: size.width * 0.46, y: size.height * 0.95))
            route.addCurve(to: center, control1: CGPoint(x: size.width * 0.42, y: size.height * 0.4), control2: CGPoint(x: size.width * 0.8, y: size.height * 0.85))
            context.stroke(route, with: .color(AcademyTheme.gold.opacity(0.65)), style: StrokeStyle(lineWidth: 1, dash: [4, 5]))
        }.overlay(alignment: .trailing) {
            Image(systemName: "airplane").font(.system(size: 55, weight: .ultraLight)).rotationEffect(.degrees(-35)).foregroundStyle(.white.opacity(0.8)).padding(.trailing, 20).offset(y: -14)
        }.accessibilityHidden(true)
    }
}

struct AcademySkillRow: View {
    @EnvironmentObject private var store: AcademyStore
    let card: AcademyAbility
    var body: some View {
        let progress = store.selectedStudentID.flatMap { store.workspace.progress(for: $0, abilityID: card.id) }
        let missing = store.selectedStudentID.map { store.workspace.missingRequirements(for: card, studentID: $0) } ?? []
        HStack(spacing: 13) {
            Image(systemName: progress?.state == .signed ? "checkmark" : progress?.state == .paused ? "pause.fill" : progress?.state == .inProgress ? "arrow.up.right" : missing.isEmpty ? card.kind.symbol : "lock")
                .font(.system(size: 16, weight: .medium)).foregroundStyle(progress?.state == .signed ? AcademyTheme.green : AcademyTheme.navy)
                .frame(width: 42, height: 44).background(progress?.state == .signed ? AcademyTheme.green.opacity(0.08) : progress?.state == .inProgress ? AcademyTheme.gold.opacity(0.35) : AcademyTheme.paper, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 5) {
                Text(card.name).font(.subheadline.weight(.semibold)).foregroundStyle(AcademyTheme.ink).fixedSize(horizontal: false, vertical: true)
                Text(progress?.state == .signed ? "Signed off" : progress?.state == .paused ? "Clearance paused" : progress?.state == .inProgress ? "\(progress?.checkedSkills.count ?? 0) of \(card.skills.count) skills demonstrated" : missing.isEmpty ? "\(card.kind.name) · \(card.skills.count) skills" : "Requires \(missing.count) \(missing.count == 1 ? "card" : "cards")")
                    .font(.caption).foregroundStyle(AcademyTheme.muted)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(AcademyTheme.muted)
        }.padding(15).background(.white, in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(progress?.state == .inProgress ? AcademyTheme.gold : AcademyTheme.line, lineWidth: 1))
            .contentShape(Rectangle())
    }
}
