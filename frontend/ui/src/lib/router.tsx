import { type AnchorHTMLAttributes, useEffect, useState } from "react";

// A small router: the pages are /, /customer, /agent and /admin, and each
// role page has sections such as /customer/claims?claim=CLM-2026-0001.

const EVENT = "esurance:navigate";
const here = () => window.location.pathname + window.location.search;

export function navigate(to: string) {
  if (to !== here()) {
    window.history.pushState(null, "", to);
    window.dispatchEvent(new Event(EVENT));
    window.scrollTo({ top: 0 });
  }
}

export function useLocation() {
  const [location, setLocation] = useState(here);
  useEffect(() => {
    const update = () => setLocation(here());
    window.addEventListener("popstate", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  const url = new URL(location, window.location.origin);
  return { path: url.pathname, query: url.searchParams };
}

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    />
  );
}
