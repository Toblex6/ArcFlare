import type { NextApiRequest, NextApiResponse } from "next";
import { executeAgentPayment } from "../../../services/agentPayService";

type Data = {
  success: boolean;
  message: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  const { merchantAddress, amountInUSDC, paymentReference } = req.body;

  if (!merchantAddress || !amountInUSDC || !paymentReference) {
    return res.status(400).json({ success: false, message: "Missing required agent payload fields." });
  }

  try {
    // Fire the async background process. 
    // The server will establish the terminal handshake sequence.
    executeAgentPayment({ merchantAddress, amountInUSDC, paymentReference });

    return res.status(200).json({ 
      success: true, 
      message: "ArcFlare Agent loop spawned. Check persistent connection log to approve." 
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}