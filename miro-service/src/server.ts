import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const { MIRO_CLIENT_ID, MIRO_CLIENT_SECRET, MIRO_REDIRECT_URI } = process.env;

const PORT = 3000;

const app = express();
app.use(express.json());

app.get("/login", (_req, res) => {
  const authorizeUrl =
    "https://miro.com/oauth/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: MIRO_CLIENT_ID ?? "",
      redirect_uri: MIRO_REDIRECT_URI ?? "",
    }).toString();

  res.redirect(authorizeUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string | undefined;

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const response = await axios.post(
      "https://api.miro.com/v1/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: MIRO_CLIENT_ID ?? "",
        client_secret: MIRO_CLIENT_SECRET ?? "",
        code,
        redirect_uri: MIRO_REDIRECT_URI ?? "",
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const accessToken = response.data.access_token;
    console.log(`ACCESS TOKEN: ${accessToken}`);

    return res.send("OAuth complete. You can return to the app.");
  } catch (error: any) {
    console.error("Miro token exchange failed:", error.response?.data ?? error.message);
    return res.status(500).send("OAuth failed");
  }
});

app.post("/test-node", async (req, res) => {
  const { accessToken, boardId } = req.body as {
    accessToken?: string;
    boardId?: string;
  };

  if (!accessToken || !boardId) {
    return res.status(400).send("Missing accessToken or boardId");
  }

  try {
    const response = await axios.post(
      `https://api.miro.com/v2/boards/${boardId}/sticky_notes`,
      {
        data: { content: "Hello from DesignTrail 🚀" },
        position: { x: 0, y: 0 },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json(response.data);
  } catch (error: any) {
    console.error("Miro create node failed:", error.response?.data ?? error.message);
    return res.status(500).send("Failed to create node");
  }
});

app.listen(PORT, () => {
  console.log(`Miro OAuth service listening on http://localhost:${PORT}`);
  console.log(`Start the flow at http://localhost:${PORT}/login`);
});
