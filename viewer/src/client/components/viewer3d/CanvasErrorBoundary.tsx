import { Component, type ReactNode } from "react";

interface CanvasErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  /** Change this (e.g. the model URL) to clear a previous error and retry. */
  resetKey?: unknown;
}

interface CanvasErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches errors thrown inside the R3F tree — most importantly an STL that fails
 * to load (404 / network / parse). useLoader re-throws to the nearest React error
 * boundary outside the <Canvas>, which this component provides.
 *
 * Error boundaries have no hook equivalent, so a class component is required here
 * (the documented exception to the functional-components rule).
 */
export class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  CanvasErrorBoundaryState
> {
  state: CanvasErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prev: CanvasErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
