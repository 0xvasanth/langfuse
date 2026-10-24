import { fireEvent, render, screen } from "@testing-library/react";

import { SaveToPromptButton } from "./SaveToPromptButton";

const mocks = vi.hoisted(() => ({
  hasAccess: true,
  push: vi.fn(),
  setPlaygroundCache: vi.fn(),
}));

vi.mock("next/router", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/src/hooks/useProjectIdFromURL", () => ({
  default: () => "project-1",
}));
vi.mock("@/src/features/rbac", () => ({
  useHasProjectAccess: ({ scope }: { scope: string }) =>
    scope === "prompts:CUD" ? mocks.hasAccess : true,
}));
vi.mock("@/src/features/posthog-analytics", () => ({
  usePostHogClientCapture: () => vi.fn(),
}));
vi.mock("@/src/features/playground/page/context/PlaygroundProvider", () => ({
  usePlaygroundContext: () => ({
    modelParams: {},
    messages: [],
    output: "",
    promptVariables: [],
  }),
}));
vi.mock("@/src/features/playground/page/hooks/usePlaygroundCache", () => ({
  default: () => ({ setPlaygroundCache: mocks.setPlaygroundCache }),
}));
vi.mock("@/src/utils/api", () => ({
  api: {
    prompts: {
      allNames: {
        useQuery: () => ({
          data: [{ name: "existing-chat-prompt", id: "prompt-1" }],
        }),
      },
    },
  },
}));

const openPopover = () => {
  // Two triggers exist (compact and wide layouts); either opens the popover.
  fireEvent.click(
    screen.getAllByRole("button", { name: "Save as prompt" })[0]!,
  );
};

describe("SaveToPromptButton", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    mocks.hasAccess = true;
    mocks.push.mockReset();
    mocks.setPlaygroundCache.mockReset();
  });

  it("disables saving and explains why when the user lacks prompts:CUD", () => {
    mocks.hasAccess = false;
    render(<SaveToPromptButton />);
    openPopover();

    const saveNew = screen.getByRole("button", { name: "Save as new prompt" });
    expect(saveNew).toBeDisabled();
    fireEvent.click(saveNew);

    fireEvent.click(screen.getByText("existing-chat-prompt"));
    expect(
      screen.getByRole("button", { name: "Save as new prompt version" }),
    ).toBeDisabled();

    expect(
      screen.getByText(/do not have permission to create prompts/i),
    ).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.setPlaygroundCache).not.toHaveBeenCalled();
  });

  it("navigates to the new prompt form when the user has prompts:CUD", () => {
    render(<SaveToPromptButton />);
    openPopover();

    expect(
      screen.queryByText(/do not have permission to create prompts/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save as new prompt" }));

    expect(mocks.setPlaygroundCache).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(
      "/project/project-1/prompts/new?loadPlaygroundCache=true",
    );
  });

  it("enables saving a new version once a chat prompt is selected", () => {
    render(<SaveToPromptButton />);
    openPopover();

    const saveVersion = screen.getByRole("button", {
      name: "Save as new prompt version",
    });
    expect(saveVersion).toBeDisabled();

    fireEvent.click(screen.getByText("existing-chat-prompt"));
    expect(saveVersion).toBeEnabled();
    fireEvent.click(saveVersion);

    expect(mocks.push).toHaveBeenCalledWith(
      "/project/project-1/prompts/new?promptId=prompt-1&loadPlaygroundCache=true",
    );
  });
});
