import { Component } from "react";

// React 18 unmounts the ENTIRE tree when an uncaught error escapes a render,
// commit, or lifecycle — leaving a blank white window with no recovery. The app
// re-renders on every window resize (AppRoot tracks `viewportWidth`), so a lone
// render-phase throw during resize is enough to white-screen the whole desktop
// app. This boundary contains that blast radius: instead of a blank window the
// user gets a recoverable error card, and the underlying error is logged so the
// real cause is diagnosable instead of invisible.
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: "" };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface the stack so a white-screen regression is debuggable from the
    // console / devtools instead of being swallowed silently.
    // eslint-disable-next-line no-console
    console.error("Unhandled UI error (app tree unmounted):", error, info?.componentStack);
    this.setState({ componentStack: info?.componentStack || "" });
  }

  handleReload() {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            padding: "24px",
            textAlign: "center",
            background: "#0b0b0d",
            color: "#f5f5f7",
            fontFamily: "system-ui, -apple-system, sans-serif"
          }}
        >
          <div style={{ fontSize: "15px", fontWeight: 600 }}>Something went wrong.</div>
          <div style={{ fontSize: "13px", opacity: 0.7, maxWidth: "420px" }}>
            The view hit an unexpected error. Reloading usually recovers it without
            losing your project.
          </div>
          {import.meta.env.DEV && (
            <pre
              style={{
                maxWidth: "min(760px, 90vw)",
                maxHeight: "40vh",
                overflow: "auto",
                margin: "8px 0 0",
                padding: "12px",
                textAlign: "left",
                fontSize: "11px",
                lineHeight: 1.45,
                color: "#ff9a9a",
                background: "#161618",
                border: "1px solid #2a2a2e",
                borderRadius: "8px",
                whiteSpace: "pre-wrap"
              }}
            >
              {String(this.state.error?.stack || this.state.error)}
              {this.state.componentStack ? `\n${this.state.componentStack}` : ""}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              marginTop: "8px",
              padding: "8px 18px",
              fontSize: "13px",
              fontWeight: 600,
              color: "#0b0b0d",
              background: "#f5f5f7",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer"
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
