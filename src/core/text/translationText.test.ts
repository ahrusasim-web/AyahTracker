import { describe, expect, it } from "vitest";
import { cleanApiText, findHaleem, parseTranslationFile } from "./translationText";

describe("translation text helpers", () => {
  it("strips footnote markers and markup", () => {
    expect(cleanApiText('In the name of God,<sup foot_note="1">1</sup> the Lord &amp; <i>Master</i>')).toBe("In the name of God, the Lord & Master");
  });

  it("parses the accepted import formats", () => {
    expect(parseTranslationFile('{"1:1":"A","2:255":"B"}').get("2:255")).toBe("B");
    expect(parseTranslationFile('[{"surah":1,"ayah":2,"text":"C"}]').get("1:2")).toBe("C");
    const tanzil = parseTranslationFile("1|1|First\n1|2|Second line\n# comment");
    expect(tanzil.get("1:2")).toBe("Second line");
    expect(tanzil.size).toBe(2);
  });

  it("finds Abdel Haleem in a translation list", () => {
    const list = { translations: [{ id: 20, name: "Saheeh International", author_name: "Saheeh International" }, { id: 85, name: "M.A.S. Abdel Haleem", author_name: "Abdul Haleem" }] };
    expect(findHaleem(list)).toEqual({ id: 85, name: "Abdul Haleem" });
    expect(findHaleem({ translations: [] })).toBeNull();
  });
});
