/** Stand-in for server-only packages (Postgres, S3, …) that the in-browser sandbox never calls. */
const unavailable = () => {
  throw new Error("not available in the browser sandbox");
};
export class Pool { constructor() { unavailable(); } }
export class Client { constructor() { unavailable(); } }
export class S3Client { constructor() { unavailable(); } }
export const PutObjectCommand = unavailable, GetObjectCommand = unavailable, DeleteObjectCommand = unavailable;
export default { Pool, Client };
