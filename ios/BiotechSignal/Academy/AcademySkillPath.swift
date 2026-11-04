import SwiftUI

struct AcademySkillPath: View {
    @EnvironmentObject private var teaching: AcademyTeachingStore
    let skill: AcademySkillLesson
    let studentID: UUID?
    private var before: [AcademySkillLesson] { skill.prerequisites.compactMap { id in teaching.skills.first { $0.id == id } } }
    private var after: [AcademySkillLesson] { teaching.skills.filter { $0.prerequisites.contains(skill.id) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack { AcademyEyebrow(text: "Your skill path", color: AcademyTheme.blue); Spacer(); Image(systemName: "arrow.triangle.branch").foregroundStyle(AcademyTheme.blue) }
            if !before.isEmpty { Text("BUILD ON").font(.caption2.monospaced()); nodes(before); connector }
            HStack { Image(systemName: "location.fill").foregroundStyle(AcademyTheme.gold); Text(skill.title).font(AcademyTheme.display(17)); Spacer() }.padding(16).foregroundStyle(.white).background(AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 15))
            if !after.isEmpty { connector; Text("OPENS A ROUTE TO").font(.caption2.monospaced()); nodes(after) }
            if before.isEmpty && after.isEmpty { Text("An independent skill you can practise alongside other projects.").font(.caption).foregroundStyle(AcademyTheme.muted) }
        }.padding(18).background(.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 22)).overlay(RoundedRectangle(cornerRadius: 22).stroke(AcademyTheme.line))
    }
    private var connector: some View { HStack { Spacer(); Image(systemName: "arrow.down").font(.caption).foregroundStyle(AcademyTheme.blue); Spacer() } }
    private func nodes(_ lessons: [AcademySkillLesson]) -> some View {
        VStack(spacing: 8) { ForEach(lessons) { lesson in
            let earned = teaching.state.awards.contains { $0.studentID == studentID && $0.skillID == lesson.id && !$0.paused }
            NavigationLink { AcademySkillLessonView(skillID: lesson.id) } label: {
                HStack(spacing: 12) { Image(systemName: earned ? "checkmark.circle.fill" : "circle.dotted").foregroundStyle(earned ? AcademyTheme.green : AcademyTheme.blue); VStack(alignment: .leading, spacing: 4) { Text(lesson.title).font(.subheadline.weight(.medium)); Text(lesson.id).font(.caption2.monospaced()).foregroundStyle(AcademyTheme.muted) }; Spacer(); Image(systemName: "chevron.right").font(.caption) }.padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain)
        } }
    }
}
