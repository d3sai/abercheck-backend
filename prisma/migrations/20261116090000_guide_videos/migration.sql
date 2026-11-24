-- CreateTable
CREATE TABLE "guide_videos" (
    "key" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "file_mtime" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guide_videos_pkey" PRIMARY KEY ("key")
);
