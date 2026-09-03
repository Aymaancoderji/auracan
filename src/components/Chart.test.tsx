import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Chart from "./Chart";

vi.mock("react-chartjs-2", () => ({
  Line: ({ data }: { data: { labels: number[]; datasets: { label: string; data: number[] }[] } }) => (
    <div data-testid="line-chart" data-points={data.datasets[0].data.length}>
      {data.datasets[0].label}
    </div>
  ),
}));

describe("Chart", () => {
  it("renders the title and passes a labeled series to the underlying chart", () => {
    const points = [
      { t: 0, v: 10 },
      { t: 1, v: 20 },
      { t: 2, v: 15 },
    ];
    render(<Chart title="Motor RPM" color="#22d3ee" points={points} unit="rpm" />);

    expect(screen.getByText("Motor RPM")).toBeInTheDocument();
    const chart = screen.getByTestId("line-chart");
    expect(chart).toHaveTextContent("Motor RPM (rpm)");
    expect(chart.getAttribute("data-points")).toBe("3");
  });

  it("renders with no data points without crashing", () => {
    render(<Chart title="Battery Voltage" color="#f59e0b" points={[]} unit="V" />);
    expect(screen.getByTestId("line-chart").getAttribute("data-points")).toBe("0");
  });
});
