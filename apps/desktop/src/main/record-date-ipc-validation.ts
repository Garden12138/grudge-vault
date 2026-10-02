import { z } from "zod";
import { recordTimeZone } from "@grudge-vault/shared";

export const recordTimeZoneSchema = z.string().max(100).refine((value) => Boolean(recordTimeZone(value)), {
  message: "Invalid time zone."
}).transform((value) => recordTimeZone(value)!);
