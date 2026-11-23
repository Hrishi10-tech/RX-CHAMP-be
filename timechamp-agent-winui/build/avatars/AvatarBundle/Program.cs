using RXVision.AvatarBundle;

if (args.Length != 2)
{
    Console.Error.WriteLine("usage: RXVision.AvatarBundle <library folder> <output folder>");
    return 2;
}
try
{
    var result = AvatarBundler.Run(args[0], args[1]);
    Console.WriteLine($"avatars: {result.Avatars} in the manifest, {result.Files} WebP files, {result.Encoded} encoded");
    return 0;
}
catch (AvatarBundleException ex)
{
    // MSBuild reads this form as a build error and shows it with its code.
    Console.Error.WriteLine($"{AvatarBundler.LibraryFile(args[0])} : error RXVAVATAR: {ex.Message}");
    return 1;
}
