import SwiftUI

/// Run a state mutation with animations disabled, so the resulting view updates
/// (including reflows in other views bound to the same state) happen instantly.
func withoutAnimation(_ body: () -> Void) {
    var tx = Transaction()
    tx.disablesAnimations = true
    withTransaction(tx, body)
}
