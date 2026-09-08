import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChoiceScreen,
  TextScreen,
  YesNoScreen,
} from "../src/components/screens.tsx";
import { dark } from "../src/components/theme.ts";
import { decodeRequest, type Request } from "../src/lib/wire.ts";

const title = "A".repeat(480) + " KEEP THE BACKUPS";
const warning = " WARNING: delete all production backups.";
const summary =
  "Review the complete request. ".repeat(150).slice(0, 4096 - warning.length) +
  warning;
const req: Request = decodeRequest(
  new TextEncoder().encode(
    JSON.stringify({
      protocol: 2,
      room: "0123456789abcdef",
      deadline_ms: 0, request_seq: 1,
      kind: "request",
      id: "display-boundary",
      title,
      summary,
      response: { kind: "yesno" },
    }),
  ),
);

describe("complete authorization context", () => {
  it("preserves accepted title and summary at the wire bounds", () => {
    const markup = renderToStaticMarkup(
      <YesNoScreen
        c={dark}
        req={req}
        expiresIn={null}
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(markup).toContain(title);
    expect(markup).toContain(summary);
  });

  it("preserves all 32 accepted choices and their distinguishing suffixes", () => {
    const options = Array.from(
      { length: 32 },
      (_, i) =>
        `${"Identical prefix ".repeat(12)}${i === 31 ? "KEEP" : "DELETE"} production ${i}`,
    );
    const choice = decodeRequest(
      new TextEncoder().encode(
        JSON.stringify({ ...req, response: { kind: "choice", options } }),
      ),
    );
    const markup = renderToStaticMarkup(
      <ChoiceScreen
        c={dark}
        req={choice}
        expiresIn={null}
        onChoose={() => {}}
      />,
    );
    expect(markup.match(/data-testid="choice-option"/g)).toHaveLength(32);
    for (const option of options) expect(markup).toContain(option);
  });

  it("continues to escape untrusted strings instead of interpreting HTML", () => {
    const markup = renderToStaticMarkup(
      <YesNoScreen
        c={dark}
        req={{ ...req, summary: "<img src=x onerror=alert(1)>" }}
        expiresIn={null}
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img");
  });

  it("names the reply and send controls without relying on the placeholder or arrow", () => {
    const markup = renderToStaticMarkup(
      <TextScreen
        c={dark}
        req={{ ...req, response: { kind: "text" } }}
        expiresIn={null}
        onSend={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Your reply"');
    expect(markup).toContain('aria-label="Send reply"');
    expect(markup).toContain('role="status"');
  });
});
