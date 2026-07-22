import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Catches unhandled render errors so the window shows a diagnostic panel
 * instead of going blank. Without this, any throw during render (for example
 * from a screen-share state transition) whites out the whole app with no
 * clue about the cause.
 *
 * The boundary logs the error and component stack to the console so it shows
 * up in the Vite dev terminal and in packaged logs, then renders a minimal
 * recovery UI with a retry button that clears the error.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error:', error);
    if (info.componentStack !== null && info.componentStack.length > 0) {
      console.error('[ErrorBoundary] Component stack:', info.componentStack);
    }
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="renderer-error-panel" role="alert">
        <h1>应用遇到错误</h1>
        <p className="renderer-error-message">{error.message}</p>
        {error.stack !== null && error.stack.length > 0 && (
          <pre className="renderer-error-stack">{error.stack}</pre>
        )}
        <button type="button" onClick={this.handleReset}>
          重试
        </button>
      </div>
    );
  }
}
