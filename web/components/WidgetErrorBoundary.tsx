import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  name: string;
  onRemove: () => void;
  children: ReactNode;
};

type State = { error: Error | null };

/** Catches render-time errors inside a widget so one broken widget can never
 *  take down the whole dashboard. Renders a small fallback with a remove
 *  button; the widget tree stays mounted so the rest of the grid keeps living. */
export default class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[widget:${this.props.name}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-2xl dim">⚠️</div>
        <div className="text-[var(--text)] text-[13px] leading-snug">
          <span className="font-semibold">{this.props.name}</span> hit an unexpected error while rendering.
        </div>
        <div className="dim text-[11px] max-w-[42ch] break-words">
          {this.state.error.message}
        </div>
        <div className="flex gap-2">
          <button
            className="px-3 py-1 text-[12px] rounded border border-[var(--border)] hover:border-[var(--amber-dim)]"
            onClick={this.reset}
          >
            Retry
          </button>
          <button
            className="px-3 py-1 text-[12px] rounded border border-[var(--border)] hover:border-[var(--down)]"
            onClick={this.props.onRemove}
          >
            Remove widget
          </button>
        </div>
      </div>
    );
  }
}