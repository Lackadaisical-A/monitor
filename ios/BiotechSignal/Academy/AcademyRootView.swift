import SwiftUI

struct AcademyRootView: View {
    @EnvironmentObject private var store: AcademyStore
    @StateObject private var teaching = AcademyTeachingStore()
    @StateObject private var cloud = AcademyCloud()
    @State private var showWorkspace = false
    @State private var showPassport = false
    @State private var showStudents = false
    @State private var showCourses = false
    @State private var courseTrack: AcademyTrack?

    var body: some View {
        NavigationStack {
            ZStack {
                AcademyTheme.paper.ignoresSafeArea()
                Group {
                    switch store.selectedTab {
                    case "map": AcademyLibraryView()
                    case "crew": AcademyStudentsView()
                    case "log": AcademyProjectsView()
                    default: AcademyTodayView()
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .safeAreaInset(edge: .bottom, spacing: 0) { tabBar }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $store.openScannedStudent) { if let id = store.selectedStudentID { AcademyStudentDetail(studentID: id) } }
            .sheet(isPresented: $showWorkspace) { AcademyWorkspaceView() }
            .sheet(isPresented: $showPassport) { AcademyPassportView() }
            .sheet(isPresented: $showStudents) { AcademyStudentPicker() }
            .sheet(isPresented: $showCourses) { AcademyCoursesView(initialTrack: courseTrack) }
            .alert("Academy", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
                Button("OK", role: .cancel) { store.errorMessage = nil }
            } message: { Text(store.errorMessage ?? "") }
            .overlay(alignment: .top) {
                if let notice = store.notice {
                    Label(notice, systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium)).padding(16).foregroundStyle(.white).background(AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 14)).padding().allowsHitTesting(false)
                        .task(id: notice) { try? await Task.sleep(for: .seconds(3)); if store.notice == notice { store.notice = nil } }
                }
            }
        }.tint(AcademyTheme.navy)
        .environmentObject(teaching)
        .environmentObject(cloud)
        .onAppear { store.cloud = cloud; teaching.load(demo: store.isDemo, students: store.workspace.students) }
        .onChange(of: store.isDemo) { _, _ in teaching.load(demo: store.isDemo, students: store.workspace.students) }
        .task { while !Task.isCancelled { try? await Task.sleep(for: .seconds(30)); if !Task.isCancelled { await cloud.sync(store: store, teaching: teaching) } } }
        .onChange(of: teaching.error) { _, message in if let message { store.errorMessage = message; teaching.error = nil } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image("AcademyBrand").renderingMode(.original).resizable().scaledToFit().frame(width: 38, height: 38).clipShape(Circle()).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("FLIGHT & AEROSPACE").font(AcademyTheme.display(11, relativeTo: .caption)).tracking(0.7)
                Text("A C A D E M Y").font(.system(size: 8, weight: .medium)).foregroundStyle(AcademyTheme.muted)
            }.accessibilityElement(children: .combine)
            Spacer()
            if store.isDemo { Text("DEMO").font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1).padding(6).background(AcademyTheme.gold.opacity(0.35), in: RoundedRectangle(cornerRadius: 5)) }
            Button { showWorkspace = true } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 18)).frame(width: 44, height: 44) }.accessibilityLabel("Workspace settings")
        }.padding(.leading, 22).padding(.trailing, 12).padding(.vertical, 7).background(.white).overlay(alignment: .bottom) { Rectangle().fill(AcademyTheme.line).frame(height: 1) }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            tab("deck", "Today", "sun.max")
            tab("crew", "Students", "person.2")
            tab("log", "Projects", "shippingbox")
            tab("map", "Library", "books.vertical")
        }.padding(.top, 11).padding(.bottom, 5).background(.white).overlay(alignment: .top) { Rectangle().fill(AcademyTheme.line).frame(height: 1) }
    }

    private func tab(_ id: String, _ title: String, _ symbol: String) -> some View {
        Button { store.selectedTab = id } label: {
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 20, weight: store.selectedTab == id ? .semibold : .regular)).frame(height: 24)
                Text(title).font(.system(size: 10, weight: store.selectedTab == id ? .bold : .medium))
                Capsule().fill(store.selectedTab == id ? AcademyTheme.navy : .clear).frame(width: 15, height: 3)
            }.frame(maxWidth: .infinity).foregroundStyle(store.selectedTab == id ? AcademyTheme.navy : AcademyTheme.muted)
        }.buttonStyle(.plain).accessibilityAddTraits(store.selectedTab == id ? .isSelected : [])
    }
}

struct AcademyDeckView: View {
    @EnvironmentObject private var store: AcademyStore
    @Binding var showPassport: Bool
    @Binding var showStudents: Bool
    @Binding var showCourses: Bool
    @Binding var courseTrack: AcademyTrack?
    @State private var selectedCard: AcademyAbility?
    @State private var addStudent = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 9) {
                        AcademyEyebrow(text: "The sky is no longer the limit")
                        Text("Room to soar.").font(AcademyTheme.display(32)).tracking(-1).foregroundStyle(AcademyTheme.navy)
                    }
                    Spacer(minLength: 0)
                }.padding(.top, 4)
                if let student = store.student {
                    passportCard(student)
                    if let card = store.currentCard { nextCard(card) }
                    else if let card = store.availableCards.first { nextCard(card) }
                    flightPath(student)
                    HStack {
                        Text("Explore the academy").font(AcademyTheme.display(18))
                        Spacer()
                        Button("Courses") { courseTrack = nil; showCourses = true }.font(.caption.weight(.semibold))
                    }
                    VStack(spacing: 10) {
                        ForEach(AcademyTrack.allCases) { track in
                            Button { courseTrack = track; showCourses = true } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: track.symbol).font(.system(size: 22, weight: .light)).frame(width: 32)
                                    VStack(alignment: .leading, spacing: 3) { Text(track.name).font(.subheadline.weight(.semibold)); Text(track.subtitle).font(.caption).foregroundStyle(AcademyTheme.muted) }
                                    Spacer(); Text(track.code).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(AcademyTheme.muted)
                                    Image(systemName: "arrow.up.right").font(.caption)
                                }.padding(16).background(.white, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(AcademyTheme.line, lineWidth: 1))
                            }.buttonStyle(.plain)
                        }
                    }
                } else {
                    AcademyEmpty(symbol: "person.crop.rectangle", title: "A new journey starts here.", message: "Add your first student, choose a track, and give every new skill a place to land.")
                    Button { addStudent = true } label: { Label("Add your first student", systemImage: "plus") }.buttonStyle(AcademyPrimaryButton())
                    Button("Explore the curriculum") { store.selectedTab = "map" }.frame(maxWidth: .infinity).font(.subheadline)
                }
                HStack(spacing: 6) { Image(systemName: "iphone"); Text(store.isDemo ? "Demo workspace · sample student records" : "Saved on this iPhone · works offline") }.font(.caption2).foregroundStyle(AcademyTheme.muted).frame(maxWidth: .infinity).padding(.bottom, 8)
            }.padding(22)
        }.sheet(item: $selectedCard) { AcademyAbilityView(cardID: $0.id) }
            .sheet(isPresented: $addStudent) { AcademyStudentEditor() }
    }

    private func passportCard(_ student: AcademyStudent) -> some View {
        VStack(alignment: .leading, spacing: 23) {
            HStack { AcademyEyebrow(text: "Student passport", color: .white.opacity(0.7)); Spacer(); Button { showPassport = true } label: { Image(systemName: "wave.3.right").font(.system(size: 20)).foregroundStyle(AcademyTheme.gold).frame(width: 32, height: 26) }.accessibilityLabel("Open student passport") }
            Button { showStudents = true } label: {
                HStack(spacing: 12) {
                    AcademyAvatar(student: student, size: 49, dark: true)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 9) { Text(student.name).font(AcademyTheme.display(22)); Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)) }
                        Text("\(store.workspace.rank(for: student))  /  \(store.workspace.curriculum.courses.first { $0.id == student.courseID }?.code ?? student.track.code)").font(.system(size: 11, weight: .medium, design: .monospaced)).foregroundStyle(AcademyTheme.gold)
                    }
                    Spacer(minLength: 0)
                }.foregroundStyle(.white)
            }.buttonStyle(.plain).accessibilityLabel("Select student, currently \(student.name)")
            HStack(alignment: .bottom, spacing: 24) {
                VStack(alignment: .leading, spacing: 3) { Text(String(format: "%02d", store.signedCount)).font(AcademyTheme.display(27)); Text("CARDS EARNED").font(.system(size: 8, weight: .medium, design: .monospaced)).tracking(1.1).foregroundStyle(.white.opacity(0.6)) }
                Rectangle().fill(.white.opacity(0.15)).frame(width: 1, height: 32)
                VStack(alignment: .leading, spacing: 3) { Text(String(format: "%02d", store.availableCards.count)).font(AcademyTheme.display(27)); Text("READY TO EXPLORE").font(.system(size: 8, weight: .medium, design: .monospaced)).tracking(1.1).foregroundStyle(.white.opacity(0.6)) }
                Spacer(minLength: 0)
                Button { Task { await store.scanPassport() } } label: { Image(systemName: "viewfinder").font(.system(size: 21, weight: .light)).frame(width: 40, height: 40).background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 11)) }.accessibilityLabel("Scan NFC passport")
            }.foregroundStyle(.white)
        }.padding(22).background { ZStack { AcademyTheme.navy; AcademyFlightDrawing() } }.clipShape(RoundedRectangle(cornerRadius: 21))
    }

    private func nextCard(_ card: AcademyAbility) -> some View {
        let checked = store.selectedStudentID.flatMap { store.workspace.progress(for: $0, abilityID: card.id)?.checkedSkills.count } ?? 0
        return Button { selectedCard = card } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack { AcademyEyebrow(text: "Continue the journey", color: AcademyTheme.blue); Spacer(); AcademyPill(text: card.kind.name) }
                HStack(alignment: .top) {
                    Text(card.name).font(AcademyTheme.display(22)).foregroundStyle(AcademyTheme.navy).multilineTextAlignment(.leading)
                    Spacer(); Image(systemName: "arrow.up.right").font(.system(size: 20, weight: .light)).foregroundStyle(AcademyTheme.navy)
                }
                HStack(spacing: 5) { ForEach(0..<card.skills.count, id: \.self) { index in Capsule().fill(index < checked ? AcademyTheme.navy : AcademyTheme.line).frame(height: 4) } }
                HStack { Text(card.laneName).font(.caption).foregroundStyle(AcademyTheme.muted); Spacer(); Text("\(checked) / \(card.skills.count) skills").font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(AcademyTheme.navy) }
            }.padding(19).background(.white, in: RoundedRectangle(cornerRadius: 17)).overlay(RoundedRectangle(cornerRadius: 17).stroke(AcademyTheme.line, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private func flightPath(_ student: AcademyStudent) -> some View {
        VStack(alignment: .leading, spacing: 19) {
            HStack { Text("The flight path").font(AcademyTheme.display(18)); Spacer(); Button { store.selectedTab = "map" } label: { HStack(spacing: 4) { Text("View map"); Image(systemName: "arrow.right") }.font(.caption.weight(.semibold)) } }
            HStack(alignment: .top, spacing: 0) {
                ForEach(1...5, id: \.self) { phase in
                    let cards = store.workspace.curriculum.cards(for: student.track).filter { $0.phase == phase }
                    let complete = !cards.isEmpty && cards.allSatisfy { store.workspace.signedIDs(for: student.id).contains($0.id) }
                    VStack(spacing: 9) {
                        ZStack {
                            Rectangle().fill(AcademyTheme.line).frame(height: 1).frame(maxWidth: .infinity)
                            Text(complete ? "✓" : String(format: "%02d", phase)).font(.system(size: 11, weight: .semibold, design: .monospaced)).frame(width: 32, height: 32).foregroundStyle(complete ? .white : AcademyTheme.navy).background(complete ? AcademyTheme.navy : AcademyTheme.paper, in: Circle()).overlay(Circle().stroke(phase <= 2 ? AcademyTheme.navy : AcademyTheme.line, lineWidth: 1))
                        }
                        Text(["Ground\nschool", "Funda-\nmentals", "Sub-\nprojects", "Capstone", "Missions"][phase - 1]).font(.system(size: 9, weight: .medium)).multilineTextAlignment(.center).foregroundStyle(AcademyTheme.muted)
                    }.frame(maxWidth: .infinity)
                }
            }
        }
    }
}

struct AcademyMapView: View {
    @EnvironmentObject private var store: AcademyStore
    @State private var track: AcademyTrack = .aerospace
    @State private var query = ""
    @State private var kind: AcademyKind?
    @State private var lane = "all"
    @State private var readyOnly = false
    @State private var selectedCard: AcademyAbility?
    @State private var showEditor = false
    private var filtered: [AcademyAbility] {
        store.workspace.curriculum.cards(for: track).filter { card in
            (kind == nil || card.kind == kind) && (lane == "all" || card.lane == lane) &&
            (query.isEmpty || "\(card.name) \(card.mission) \(card.laneName) \(card.course)".localizedCaseInsensitiveContains(query)) &&
            (!readyOnly || store.availableCards.contains(where: { $0.id == card.id }))
        }
    }
    private var focusCard: AcademyAbility? {
        if let card = store.currentCard, card.programs.contains(track) { return card }
        return store.availableCards.first { $0.programs.contains(track) } ?? store.workspace.curriculum.cards(for: track).first
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) { AcademyEyebrow(text: "Small skills. Extraordinary futures."); Text("Skill map").font(AcademyTheme.display(32)).foregroundStyle(AcademyTheme.navy) }
                    Spacer(); Button { showEditor = true } label: { Image(systemName: "plus").frame(width: 42, height: 42).background(.white, in: Circle()) }.accessibilityLabel("Add curriculum card")
                }
                Picker("Track", selection: $track) { ForEach(AcademyTrack.allCases) { Text($0.name).tag($0) } }.pickerStyle(.segmented)
                if query.isEmpty && kind == nil && lane == "all" && !readyOnly, let focus = focusCard {
                    AcademyDependencyPath(card: focus) { selectedCard = $0 }
                }
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(AcademyTheme.muted); TextField("Find a skill, card, or course", text: $query).font(.subheadline).accessibilityLabel("Search skill map"); if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Clear search") } }.padding(14).background(.white, in: RoundedRectangle(cornerRadius: 12))
                HStack(spacing: 8) {
                    Menu { Button("All card types") { kind = nil }; ForEach(AcademyKind.allCases) { item in Button(item.name) { kind = item } } } label: { Label(kind?.name ?? "All cards", systemImage: "line.3.horizontal.decrease").font(.caption.weight(.medium)).padding(10).background(.white, in: Capsule()) }
                    Menu { Button("All specialties") { lane = "all" }; ForEach(AcademyCurriculum.lanes.keys.sorted(), id: \.self) { key in Button(AcademyCurriculum.lanes[key] ?? key) { lane = key } } } label: { Text(lane == "all" ? "Specialty ⌄" : AcademyCurriculum.lanes[lane] ?? lane).font(.caption.weight(.medium)).lineLimit(1).padding(10).background(.white, in: Capsule()) }
                    Spacer(minLength: 0)
                    Button { readyOnly.toggle() } label: { Image(systemName: readyOnly ? "bolt.circle.fill" : "bolt.circle").font(.system(size: 25)).frame(width: 36, height: 40) }.accessibilityLabel(readyOnly ? "Show all progress states" : "Show only ready cards").disabled(store.student == nil)
                }
                HStack { Text("\(filtered.count) cards · editable draft curriculum").font(.caption).foregroundStyle(AcademyTheme.muted); Spacer() }
                if filtered.isEmpty { AcademyEmpty(symbol: "magnifyingglass", title: "No cards on this route.", message: "Try another search or clear the filters.") }
                ForEach(1...5, id: \.self) { phase in
                    let cards = filtered.filter { $0.phase == phase }
                    if !cards.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(spacing: 11) {
                                Text(String(format: "%02d", phase)).font(.system(size: 11, weight: .semibold, design: .monospaced)).frame(width: 31, height: 31).background(AcademyTheme.navy, in: Circle()).foregroundStyle(.white)
                                Text(AcademyCurriculum.phases[phase - 1]).font(AcademyTheme.display(18)); Spacer(); Text("\(cards.count)").font(.caption.monospaced()).foregroundStyle(AcademyTheme.muted)
                            }.padding(.bottom, 5)
                            ForEach(cards) { card in Button { selectedCard = card } label: { AcademySkillRow(card: card) }.buttonStyle(.plain) }
                        }
                    }
                }
            }.padding(22)
        }.onAppear { track = store.student?.track ?? .aerospace }
            .sheet(item: $selectedCard) { AcademyAbilityView(cardID: $0.id) }
            .sheet(isPresented: $showEditor) { AcademyAbilityEditor(existing: nil, track: track) }
    }
}

struct AcademyDependencyPath: View {
    @EnvironmentObject private var store: AcademyStore
    let card: AcademyAbility
    let select: (AcademyAbility) -> Void
    private var prerequisites: [AcademyAbility] { card.requires.compactMap { store.workspace.curriculum.ability($0) } }
    private var next: [AcademyAbility] { store.cards.filter { $0.requires.contains(card.id) } }
    var body: some View {
        VStack(spacing: 0) {
            HStack { AcademyEyebrow(text: "One skill opens another", color: AcademyTheme.blue); Spacer(); Image(systemName: "arrow.triangle.branch").foregroundStyle(AcademyTheme.blue) }.padding(.bottom, 20)
            if !prerequisites.isEmpty {
                nodes(prerequisites)
                connectors(count: prerequisites.count, converging: true)
            }
            Button { select(card) } label: {
                VStack(spacing: 8) { Label(card.kind.name.uppercased(), systemImage: card.kind.symbol).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1); Text(card.name).font(AcademyTheme.display(18)).multilineTextAlignment(.center); Text("YOUR CURRENT ROUTE").font(.system(size: 8, weight: .medium, design: .monospaced)).tracking(1).foregroundStyle(AcademyTheme.gold) }.frame(maxWidth: .infinity).padding(18).foregroundStyle(.white).background(AcademyTheme.navy, in: RoundedRectangle(cornerRadius: 15))
            }.buttonStyle(.plain)
            if !next.isEmpty {
                connectors(count: min(next.count, 3), converging: false)
                nodes(Array(next.prefix(3)))
                if next.count > 3 { Text("+\(next.count - 3) more cards unlocked by this route").font(.caption2).foregroundStyle(AcademyTheme.muted).padding(.top, 12) }
            }
        }.padding(17).background(Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 19)).overlay(RoundedRectangle(cornerRadius: 19).stroke(AcademyTheme.line, lineWidth: 1))
    }
    private func nodes(_ cards: [AcademyAbility]) -> some View {
        HStack(alignment: .top, spacing: 7) {
            ForEach(cards) { node in
                let signed = store.selectedStudentID.map { store.workspace.signedIDs(for: $0).contains(node.id) } ?? false
                Button { select(node) } label: {
                    VStack(spacing: 7) { Image(systemName: signed ? "checkmark.circle.fill" : node.kind.symbol).font(.system(size: 15, weight: .light)).foregroundStyle(signed ? AcademyTheme.green : AcademyTheme.blue); Text(node.name).font(.system(size: 11, weight: .medium)).lineLimit(3).multilineTextAlignment(.center).foregroundStyle(AcademyTheme.navy) }.frame(maxWidth: .infinity, minHeight: 66).padding(8).background(.white, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(signed ? AcademyTheme.green.opacity(0.3) : AcademyTheme.line, lineWidth: 1))
                }.buttonStyle(.plain)
            }
        }
    }
    private func connectors(count: Int, converging: Bool) -> some View {
        Canvas { context, size in
            for index in 0..<count {
                let edge = CGFloat(index * 2 + 1) * size.width / CGFloat(count * 2)
                let from = CGPoint(x: converging ? edge : size.width / 2, y: 0)
                let to = CGPoint(x: converging ? size.width / 2 : edge, y: size.height)
                var path = Path(); path.move(to: from); path.addCurve(to: to, control1: CGPoint(x: from.x, y: size.height * 0.65), control2: CGPoint(x: to.x, y: size.height * 0.35))
                context.stroke(path, with: .color(AcademyTheme.blue.opacity(0.35)), lineWidth: 1.2)
            }
        }.frame(height: 29).accessibilityHidden(true)
    }
}
