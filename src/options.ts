import { loadDir, pickDir, clearDir } from "./store";

const current = document.getElementById("current")!;
const msg = document.getElementById("msg")!;

async function refresh() {
  const d = await loadDir();
  current.textContent = d
    ? `Pasta atual: ${d.name}`
    : "Nenhuma pasta escolhida: os downloads vão para a pasta Downloads do navegador.";
}

document.getElementById("pick")!.addEventListener("click", async () => {
  msg.textContent = "";
  try {
    await pickDir();
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") msg.textContent = "Erro: " + (e as Error).message;
  }
  await refresh();
});

document.getElementById("clear")!.addEventListener("click", async () => {
  msg.textContent = "";
  await clearDir();
  await refresh();
});

refresh();
