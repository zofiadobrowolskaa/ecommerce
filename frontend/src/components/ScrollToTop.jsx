import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// scrolls to the top of the page instantly on every route change
// placed inside BrowserRouter so it can read useLocation
const ScrollToTop = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    // instant scroll is correct for page navigation — smooth feels sluggish here
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
};

export default ScrollToTop;
