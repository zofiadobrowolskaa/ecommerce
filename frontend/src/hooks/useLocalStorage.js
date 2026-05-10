import { useState, useEffect } from 'react';

/*
  custom hook for persistent state.
  stores data in localStorage.
 */

function useLocalStorage(key, initialValue) {

// lazy state init - runs only on first render.
  const [value, setValue] = useState(() => {
    try {
      // read value from localStorage
      const item = window.localStorage.getItem(key);

      // parse stored json or use default
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      return initialValue;
    }
  });

  //  sync state changes to localStorage
  useEffect(() => {
    try {
      // save updated value as json
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // fallback to initialValue if JSON parse fails
    }
  }, [key, value]);

  return [value, setValue];
}

export default useLocalStorage;