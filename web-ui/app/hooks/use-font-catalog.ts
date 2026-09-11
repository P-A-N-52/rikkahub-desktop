import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import api from "~/services/api";
import type { FontCatalog } from "~/types/font";

// 字体目录查询。staleTime=Infinity:字体增删频率极低,上传/删除后由调用方显式 invalidate。
export const FONT_CATALOG_QUERY_KEY = ["fonts", "catalog"] as const;

export function useFontCatalog() {
  const basic = useQuery({
    queryKey: [...FONT_CATALOG_QUERY_KEY, "basic"],
    queryFn: () => api.get<FontCatalog>("fonts/list?system=0"),
    staleTime: Infinity,
  });
  const system = useQuery({
    queryKey: [...FONT_CATALOG_QUERY_KEY, "system"],
    queryFn: () => api.get<Pick<FontCatalog, "system">>("fonts/system", { retry: 0 }),
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // Bundled/custom font faces become available before slow native enumeration.
  // Recompute exclusions when uploaded fonts change, preserving their priority.
  const data = React.useMemo<FontCatalog | undefined>(() => {
    if (!basic.data) return undefined;
    const exclude = new Set([...basic.data.builtin, ...basic.data.custom].map((font) => font.cssName.toLowerCase()));
    return {
      ...basic.data,
      system: (system.data?.system ?? []).filter((font) => !exclude.has(font.cssName.toLowerCase())),
    };
  }, [basic.data, system.data]);

  return {
    data,
    isLoading: basic.isLoading,
    isSystemLoading: system.isFetching,
    systemError: system.error,
    refetchSystem: system.refetch,
  };
}

export function useInvalidateFontCatalog() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: FONT_CATALOG_QUERY_KEY });
}
