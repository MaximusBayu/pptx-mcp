import { randomBytes } from "crypto";
export const createId = () => randomBytes(12).toString("hex");
