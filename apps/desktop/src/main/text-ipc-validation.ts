import { z } from "zod";
import { codePointLength } from "@grudge-vault/shared";

export function boundedTextSchema(maximum: number) {
  return z.string().refine((value) => value.length <= maximum * 2 && codePointLength(value) <= maximum, {
    message: "Text exceeds the Unicode character limit."
  });
}
