import Foundation

/// Watches for the web UI server to come back while the offline view shows.
///
/// Asks the server directly every couple of seconds rather than reloading
/// the web view: a failed load flashes the view and, worse, leaves the old
/// page's scripts running behind it. Any HTTP answer at all (a 401 included)
/// means the server is up; only a network failure means it isn't. Calls
/// onUp once, then stops.
@MainActor
final class ServerWatch {
    static let interval: TimeInterval = 2

    var onUp: (() -> Void)?

    private let url: URL
    private let session: URLSession
    private var timer: Timer?
    private var inFlight = false

    init(url: URL) {
        self.url = url
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = ServerWatch.interval
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    var isWatching: Bool { timer != nil }

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: ServerWatch.interval, target: self, selector: #selector(probe),
                      userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    @objc private func probe() {
        // One at a time: a slow answer must not stack up behind the timer.
        guard !inFlight else { return }
        inFlight = true
        session.dataTask(with: url) { [weak self] _, response, _ in
            let up = response is HTTPURLResponse
            Task { @MainActor in
                guard let self else { return }
                self.inFlight = false
                guard up, self.isWatching else { return }
                self.stop()
                self.onUp?()
            }
        }.resume()
    }
}
