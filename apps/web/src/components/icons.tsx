import type { SVGProps } from "react";

export function Arrow({ diagonal = false, ...props }: SVGProps<SVGSVGElement> & { diagonal?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{diagonal ? <path d="M6 18 18 6M6 6h12v12" /> : <path d="M4 12h15m-6-6 6 6-6 6" />}</svg>;
}

export function Mark({ className = "" }: { className?: string }) {
  return <svg className={className} width="31" height="31" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m3 9 7 22 10-13 10 13 7-22M10 31V9m20 22V9" stroke="currentColor" strokeWidth="3.4" strokeLinecap="square" strokeLinejoin="miter" /></svg>;
}

export function Signal({ className = "" }: { className?: string }) {
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;
}
