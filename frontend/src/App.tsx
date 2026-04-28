import { Routes, Route, useLocation } from "react-router-dom";
import HomePage from "./pages/HomePage";
import WebcamPage from "./pages/WebcamPage";
import IpcamPage from "./pages/IpcamPage";
import ModelsPage from "./pages/ModelsPage";
import Header from "./components/Header";

function App() {
  const location = useLocation();
  // HomePage 는 풀스크린 랜딩이라 헤더 숨김. 다른 페이지는 헤더 표시.
  const showHeader = location.pathname !== "/";

  return (
    <>
      {showHeader && <Header />}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/webcam" element={<WebcamPage />} />
        <Route path="/ipcam" element={<IpcamPage />} />
        <Route path="/models" element={<ModelsPage />} />
      </Routes>
    </>
  );
}

export default App;
