import { Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import WebcamPage from "./pages/WebcamPage";
import IpcamPage from "./pages/IpcamPage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/webcam" element={<WebcamPage />} />
      <Route path="/ipcam" element={<IpcamPage />} />
    </Routes>
  );
}

export default App;
