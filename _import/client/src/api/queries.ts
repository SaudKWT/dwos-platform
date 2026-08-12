import { useQuery } from '@tanstack/react-query'
import { api } from './client'

// Reference data (fleet, berths, rigs) changes about never, so it is cached for
// the session rather than refetched per screen.
const STATIC = { staleTime: Infinity, gcTime: Infinity }

export const useVessels = () => useQuery({ queryKey: ['vessels'], queryFn: api.vessels, ...STATIC })
export const useLocations = () => useQuery({ queryKey: ['locations'], queryFn: api.locations, ...STATIC })

export const useReportIndex = () => useQuery({ queryKey: ['reports'], queryFn: api.reportIndex })
export const useReport = (vesselId?: string, date?: string) =>
  useQuery({
    queryKey: ['report', vesselId, date],
    queryFn: () => api.report(vesselId!, date!),
    enabled: Boolean(vesselId && date),
  })

export const usePlanIndex = () => useQuery({ queryKey: ['plans'], queryFn: api.planIndex })
export const useAisIndex = () => useQuery({ queryKey: ['ais'], queryFn: api.aisIndex })
export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: api.health })
