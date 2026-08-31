import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlertLog from "./AlertLog";
import { AlertEntry } from "../lib/alerts";

describe("AlertLog", () => {
  it("shows a placeholder when there are no alerts", () => {
    render(<AlertLog alerts={[]} />);
    expect(screen.getByText("No alerts yet.")).toBeInTheDocument();
  });

  it("renders an entered-danger alert and a cleared alert distinctly", () => {
    const alerts: AlertEntry[] = [
      { id: "1", time: 0, label: "MotorRPM", level: "danger", value: 7600, unit: "rpm" },
      { id: "2", time: 1, label: "MotorRPM", level: "cleared", value: 3000, unit: "rpm" },
    ];
    const { container } = render(<AlertLog alerts={alerts} />);

    // Text is split across several JSX expressions within each row, so
    // check the rendered output as a whole rather than risking an
    // ambiguous multi-element match from a substring/regex query.
    expect(container.textContent).toContain("entered DANGER");
    expect(container.textContent).toContain("cleared");
    expect(container.textContent).toContain("7600.0rpm");
    expect(container.textContent).toContain("3000.0rpm");
  });
});
