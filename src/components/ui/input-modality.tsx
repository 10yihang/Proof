import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type InputModality = "pointer" | "keyboard";
const InputModalityContext = createContext<InputModality>("pointer");

// Capture before the control's handler so its next state uses the same modality.
export function InputModalityProvider({ children }: { children: ReactNode }) {
  const [modality, setModality] = useState<InputModality>("pointer");
  useEffect(() => {
    const update = (next: InputModality) => {
      document.documentElement.dataset.inputModality = next;
      setModality(next);
    };
    const pointer = () => update("pointer");
    const keyboard = (event: KeyboardEvent) => {
      if (!["Meta", "Control", "Alt", "Shift"].includes(event.key))
        update("keyboard");
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", keyboard, true);
      delete document.documentElement.dataset.inputModality;
    };
  }, []);
  return (
    <InputModalityContext.Provider value={modality}>
      {children}
    </InputModalityContext.Provider>
  );
}

export function useInputModality() {
  return useContext(InputModalityContext);
}
