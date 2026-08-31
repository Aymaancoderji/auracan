import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Gauge from "./Gauge";

describe("Gauge", () => {
  it("renders the label, rounded value, and unit", () => {
    render(<Gauge label="Motor RPM" value={4213.7} min={0} max={8000} unit="rpm" />);
    expect(screen.getByText("Motor RPM")).toBeInTheDocument();
    expect(screen.getByText("4214")).toBeInTheDocument();
    expect(screen.getByText("rpm")).toBeInTheDocument();
  });

  it("clamps the displayed value to the min/max range", () => {
    render(<Gauge label="Slot" value={999} min={0} max={100} unit="%" />);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.queryByText("999")).not.toBeInTheDocument();
  });

  it("shows a valueLabel (e.g. a DBC VAL_ enum label) instead of the raw number when given", () => {
    render(<Gauge label="Gear" value={3} min={0} max={15} unit="" valueLabel="Drive" />);
    expect(screen.getByText("Drive")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });
});
