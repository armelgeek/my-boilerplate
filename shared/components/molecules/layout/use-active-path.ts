"use client";
import { usePathname } from "next/navigation";

export function useActivePath() {
  const pathname = usePathname();
  return pathname;
}
