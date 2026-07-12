import SwiftUI
import UIKit

/// A UIKit-backed text field that grabs focus and selects all its text as soon
/// as it appears, so the user can immediately overwrite the existing value.
/// `selectAllTrigger` re-runs the select-all when its value changes (the parent
/// increments it from a "highlight all" button).
struct SelectAllTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder = ""
    /// When true, grabs focus + selects all text the first time the view appears.
    var autoSelectOnAppear: Bool = true
    /// Increment this from the parent to re-select all the text on demand.
    var selectAllTrigger: Int = 0
    var onSubmit: () -> Void = {}

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = placeholder
        field.text = text
        field.delegate = context.coordinator
        field.returnKeyType = .done
        field.clearButtonMode = .whileEditing
        field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged(_:)), for: .editingChanged)
        context.coordinator.lastTrigger = selectAllTrigger
        if autoSelectOnAppear {
            DispatchQueue.main.async {
                field.becomeFirstResponder()
                field.selectAll(nil)
            }
        }
        return field
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        if uiView.text != text { uiView.text = text }
        if context.coordinator.lastTrigger != selectAllTrigger {
            context.coordinator.lastTrigger = selectAllTrigger
            DispatchQueue.main.async {
                uiView.becomeFirstResponder()
                uiView.selectAll(nil)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        private let parent: SelectAllTextField
        var lastTrigger: Int = 0
        init(_ parent: SelectAllTextField) { self.parent = parent }
        @objc func editingChanged(_ field: UITextField) { parent.text = field.text ?? "" }
        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            parent.onSubmit(); return true
        }
    }
}
