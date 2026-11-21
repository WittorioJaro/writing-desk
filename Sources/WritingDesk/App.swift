import SwiftUI
import AppKit
import WritingDeskCore

@MainActor
final class DeskModel: ObservableObject {
    @Published private(set) var state: AppState
    @Published var selection: UUID?
    @Published var status = ""
    @Published var showCovers = false
    @Published var showIdeas = true
    @Published var ideaDraft = ""
    let workspace: Workspace
    var store: Store { workspace.store }
    /// Non-nil when state.json couldn't be loaded: the app is read-only until relaunched after recovery.
    var loadError: String? { workspace.loadError }
    var isWritable: Bool { workspace.isWritable }

    init() {
        let store: Store
        do { store = try Store() } catch { fatalError("Can't create data folder at \(Store.defaultRoot.path): \(error)") }
        workspace = Workspace(store: store)
        state = workspace.state
        if workspace.isWritable {
            if state.articles.isEmpty { mutate { $0.articles.append(Article(title: "First article")) } }
            checkInbox()
        } else {
            status = "Read-only: state.json couldn't be loaded"
        }
        selection = state.articles.first?.id
    }

    /// Every write goes through here. A read-only workspace refuses it and nothing is written.
    private func mutate(_ change: (inout AppState) -> Void) {
        do { try workspace.mutate(change) } catch { status = "Not saved: \(error.localizedDescription)" }
        state = workspace.state
    }

    var currentIndex: Int? { state.articles.firstIndex { $0.id == selection } }

    func updateBody(_ new: String) {
        guard let i = currentIndex, state.articles[i].body != new else { return }
        mutate { s in
            let old = s.articles[i].wordCount
            s.articles[i].body = new
            s.articles[i].updated = Date()
            s.accountability.recordEdit(oldWordCount: old, newWordCount: s.articles[i].wordCount)
        }
    }

    func updateTitle(_ new: String) {
        guard let i = currentIndex else { return }
        mutate { $0.articles[i].title = new }
    }

    func setGoal(_ goal: Int) { mutate { $0.accountability.dailyGoal = max(50, goal) } }

    func newArticle() {
        let a = Article()
        mutate { $0.articles.insert(a, at: 0) }
        if state.articles.contains(where: { $0.id == a.id }) { selection = a.id }
    }

    func delete(_ id: UUID) {
        mutate { $0.articles.removeAll { $0.id == id } }
        if selection == id { selection = state.articles.first?.id }
    }

    func addIdea(_ text: String) { mutate { $0.ideas.append(Idea(text: text, source: "added in app")) } }

    func checkInbox() {
        do {
            let r = try workspace.importInbox()
            state = workspace.state
            if !r.errors.isEmpty {
                status = "Inbox: \(r.added) imported; " + r.errors.joined(separator: " · ")
            } else {
                status = r.added > 0 ? "Imported \(r.added) new idea\(r.added == 1 ? "" : "s") from Elon" : "Inbox checked — nothing new"
            }
        } catch { status = error.localizedDescription }
    }

    func toggleIdea(_ id: UUID) {
        guard let i = state.ideas.firstIndex(where: { $0.id == id }) else { return }
        mutate { $0.ideas[i].done.toggle() }
    }
}

@main
struct WritingDeskApp: App {
    @StateObject private var model = DeskModel()
    init() { NSApplication.shared.setActivationPolicy(.regular) }
    var body: some Scene {
        WindowGroup("Writing Desk") {
            ContentView().environmentObject(model)
                .frame(minWidth: 900, minHeight: 560)
                .onAppear { NSApp.activate(ignoringOtherApps: true) }
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Article") { model.newArticle() }.keyboardShortcut("n").disabled(!model.isWritable)
                Button("Check Ideas Inbox") { model.checkInbox() }.keyboardShortcut("i", modifiers: [.command, .shift]).disabled(!model.isWritable)
            }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: DeskModel

    var body: some View {
        NavigationSplitView {
            List(selection: $model.selection) {
                Section("Articles") {
                    ForEach(model.state.articles) { a in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title.isEmpty ? "Untitled" : a.title).lineLimit(1)
                            Text("\(a.wordCount) words").font(.caption).foregroundStyle(.secondary)
                        }
                        .tag(a.id)
                        .contextMenu { Button("Delete", role: .destructive) { model.delete(a.id) } }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { GoalPanel().padding(10) }
            .toolbar { Button { model.newArticle() } label: { Image(systemName: "square.and.pencil") }.help("New article").disabled(!model.isWritable) }
            .navigationSplitViewColumnWidth(min: 200, ideal: 230)
        } detail: {
            VStack(spacing: 0) {
            if let err = model.loadError { LoadErrorBanner(message: err, folder: model.store.root) }
            HStack(spacing: 0) {
                if let i = model.currentIndex {
                    EditorView(article: model.state.articles[i]).id(model.state.articles[i].id)
                } else {
                    Text("No article selected").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if model.showIdeas { Divider(); IdeasPanel().frame(width: 260) }
            }
            }
            .toolbar {
                ToolbarItemGroup {
                    Button { model.showCovers = true } label: { Label("Covers", systemImage: "photo.on.rectangle.angled") }
                        .disabled(model.currentIndex == nil).help("Generate cover options from this article")
                    Toggle(isOn: $model.showIdeas) { Label("Ideas", systemImage: "lightbulb") }.help("Show Elon's ideas")
                }
            }
        }
        .sheet(isPresented: $model.showCovers) {
            if let i = model.currentIndex { CoversSheet(article: model.state.articles[i]) }
        }
    }
}

struct EditorView: View {
    @EnvironmentObject var model: DeskModel
    let article: Article

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Title", text: Binding(get: { article.title }, set: { model.updateTitle($0) }))
                .textFieldStyle(.plain).font(.system(size: 26, weight: .semibold, design: .serif))
                .padding(.horizontal, 40).padding(.top, 28).padding(.bottom, 8)
            TextEditor(text: Binding(get: { article.body }, set: { model.updateBody($0) }))
                .font(.system(size: 16, design: .serif)).lineSpacing(5)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 36)
            HStack {
                Text("\(article.wordCount) words").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(model.status).font(.caption).foregroundStyle(.secondary)
            }.padding(.horizontal, 40).padding(.vertical, 8)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .disabled(!model.isWritable)
    }
}

struct GoalPanel: View {
    @EnvironmentObject var model: DeskModel
    var body: some View {
        let acc = model.state.accountability
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Today").font(.caption.bold())
                Spacer()
                Text("\(acc.words()) / \(acc.dailyGoal)").font(.caption.monospacedDigit())
            }
            ProgressView(value: acc.progress()).tint(acc.progress() >= 1 ? .green : .accentColor)
            HStack(alignment: .bottom, spacing: 3) {
                let recent = acc.recent(days: 14)
                let maxW = max(acc.dailyGoal, recent.map(\.words).max() ?? 1)
                ForEach(recent, id: \.day) { d in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(d.words >= acc.dailyGoal ? Color.green : Color.secondary.opacity(d.words > 0 ? 0.6 : 0.2))
                        .frame(width: 9, height: max(3, 34 * CGFloat(d.words) / CGFloat(maxW)))
                        .help("\(d.day): \(d.words) words")
                }
            }.frame(height: 34, alignment: .bottom)
            HStack {
                Text("Streak: \(acc.streak()) day\(acc.streak() == 1 ? "" : "s")").font(.caption)
                Spacer()
                Stepper("Goal", value: Binding(get: { model.state.accountability.dailyGoal },
                                               set: { model.setGoal($0) }),
                        step: 50).font(.caption).labelsHidden()
            }
        }
        .padding(10).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct IdeasPanel: View {
    @EnvironmentObject var model: DeskModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("From Elon").font(.headline)
                Spacer()
                Button { model.checkInbox() } label: { Image(systemName: "tray.and.arrow.down") }.buttonStyle(.borderless).help("Check inbox folder").disabled(!model.isWritable)
                Button { NSWorkspace.shared.open(model.store.inboxURL) } label: { Image(systemName: "folder") }.buttonStyle(.borderless).help("Open inbox folder")
            }
            Text("Prompts & things to think about. Never mixed into your article.").font(.caption).foregroundStyle(.secondary)
            List {
                ForEach(model.state.ideas.reversed()) { idea in
                    HStack(alignment: .top) {
                        Button { model.toggleIdea(idea.id) } label: { Image(systemName: idea.done ? "checkmark.circle.fill" : "circle") }.buttonStyle(.borderless)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(idea.text).strikethrough(idea.done).foregroundStyle(idea.done ? .secondary : .primary)
                            Text(idea.source).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }.listStyle(.plain)
            TextField("Add idea manually…", text: $model.ideaDraft).disabled(!model.isWritable).onSubmit {
                let t = model.ideaDraft.trimmingCharacters(in: .whitespaces)
                guard !t.isEmpty else { return }
                model.addIdea(t); model.ideaDraft = ""
            }
        }.padding(12)
    }
}

struct CoversSheet: View {
    @EnvironmentObject var model: DeskModel
    @Environment(\.dismiss) var dismiss
    let article: Article

    var body: some View {
        let seed = CoverSeed(title: article.title, body: article.body)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Cover options").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            Text("5:2 · 1500×600 · generated offline from: \(seed.keywords.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                    ForEach(CoverStyle.allCases) { style in
                        let img = CoverGenerator.render(seed: seed, style: style)
                        VStack(alignment: .leading, spacing: 6) {
                            Image(decorative: img, scale: 1).resizable().aspectRatio(5.0 / 2.0, contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            HStack {
                                Text(style.label).font(.caption)
                                Spacer()
                                Button("Export PNG…") { export(img, style: style) }.controlSize(.small)
                            }
                        }
                    }
                }
            }
        }
        .padding(20).frame(width: 820, height: 620)
    }

    func export(_ img: CGImage, style: CoverStyle) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.directoryURL = model.store.coversURL
        let base = article.title.isEmpty ? "cover" : article.title.replacingOccurrences(of: "/", with: "-")
        panel.nameFieldStringValue = "\(base)-\(style.rawValue).png"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try CoverGenerator.exportPNG(img, to: url); model.status = "Saved \(url.lastPathComponent)" }
        catch { model.status = "Export failed: \(error.localizedDescription)" }
    }
}

struct LoadErrorBanner: View {
    let message: String
    let folder: URL
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 4) {
                Text("Your saved data couldn't be loaded, so editing is disabled.").bold()
                Text(message).font(.caption).textSelection(.enabled)
                Text("Nothing was overwritten. Fix or move state.json aside, then relaunch Writing Desk.").font(.caption)
            }.foregroundStyle(.white)
            Spacer()
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([folder.appendingPathComponent("state.json")]) }
        }
        .padding(12).background(Color.red.opacity(0.85))
    }
}
