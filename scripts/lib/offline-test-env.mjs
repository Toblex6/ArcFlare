// CI verification must not consume repo dotenv credentials. The runner passes
// only OS essentials, DATABASE_URL, and explicit throwaway application config.
import dotenv from 'dotenv';
dotenv.config = () => ({ parsed: {} });
