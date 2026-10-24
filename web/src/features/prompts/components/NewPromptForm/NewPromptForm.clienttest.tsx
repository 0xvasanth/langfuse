import { render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";

import { TooltipProvider } from "@/src/components/ui/tooltip";
import { PromptType, type Prompt } from "@langfuse/shared";
import { NewPromptForm } from "./NewPromptForm";

const mocks = vi.hoisted(() => ({
  hasAccess: true,
}));

vi.mock("next/router", () => ({
  default: { push: vi.fn() },
  useRouter: () => ({ push: vi.fn(), query: {} }),
}));
vi.mock("use-query-params", () => ({
  useQueryParam: () => [undefined, vi.fn()],
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
vi.mock("@/src/features/playground", () => ({
  usePlaygroundCache: () => ({ playgroundCache: null }),
}));
vi.mock("@/src/hooks/useFormPersistence", () => ({
  useFormPersistence: () => ({ hadDraft: false, clearDraft: vi.fn() }),
}));
vi.mock("@/src/features/prompts/hooks/usePromptNameValidation", () => ({
  usePromptNameValidation: () => undefined,
}));
vi.mock("@/src/components/editor/CodeMirrorEditor", () => ({
  CodeMirrorEditor: () => null,
}));
vi.mock("@/src/components/editor/PromptLinkingEditor", () => ({
  PromptLinkingEditor: () => null,
}));
vi.mock("./PromptChatMessages", () => ({
  PromptChatMessages: () => null,
}));
vi.mock("./ReviewPromptDialog", () => ({
  ReviewPromptDialog: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/src/utils/api", () => ({
  api: {
    useUtils: () => ({ prompts: { invalidate: vi.fn() } }),
    prompts: {
      create: {
        useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
      },
      filterOptions: { useQuery: () => ({ data: undefined }) },
    },
  },
  reportTrpcErrorWithoutToast: vi.fn(),
}));

const existingPrompt = {
  id: "prompt-1",
  projectId: "project-1",
  name: "existing-prompt",
  version: 1,
  type: PromptType.Text,
  prompt: "Hello {{name}}",
  config: {},
  labels: [],
  tags: [],
  commitMessage: null,
} as unknown as Prompt;

const renderForm = (initialPrompt?: Prompt) =>
  render(
    <TooltipProvider>
      <NewPromptForm initialPrompt={initialPrompt} />
    </TooltipProvider>,
  );

const noAccessMessage = /do not have permission to create prompts/i;

describe("NewPromptForm prompts:CUD access", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  beforeEach(() => {
    mocks.hasAccess = true;
  });

  it("disables creating a new prompt without prompts:CUD", () => {
    mocks.hasAccess = false;
    renderForm();

    expect(
      screen.getByRole("button", { name: "Create prompt" }),
    ).toBeDisabled();
    expect(screen.getByText(noAccessMessage)).toBeInTheDocument();
  });

  it("disables saving a new version without prompts:CUD", () => {
    mocks.hasAccess = false;
    renderForm(existingPrompt);

    expect(
      screen.getByRole("button", { name: "Save new prompt version" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review changes" }),
    ).toBeDisabled();
    expect(screen.getByText(noAccessMessage)).toBeInTheDocument();
  });

  it("keeps the create button enabled with prompts:CUD", () => {
    renderForm();

    expect(screen.getByRole("button", { name: "Create prompt" })).toBeEnabled();
    expect(screen.queryByText(noAccessMessage)).not.toBeInTheDocument();
  });
});
