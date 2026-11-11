@echo off
rem BlueScreen - instalador. Duplo clique: compila a partir deste repositorio e instala no seu usuario (sem admin).
rem A janela e feita em WPF; o script dela fica neste mesmo arquivo, logo abaixo (o cmd para no exit /b e nunca chega la).
rem o caminho vai por variavel de ambiente: um apostrofo no nome da pasta quebraria a string do PowerShell
set "BS_SETUP_FILE=%~f0"
start "" powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$SetupFile=$env:BS_SETUP_FILE; $t=[IO.File]::ReadAllText($SetupFile,[Text.Encoding]::UTF8); iex $t.Substring($t.IndexOf('#'+'##PS')+5)"
exit /b
###PS
# ===== Instalador do BlueScreen =====
# Fluxo: versão pronta do GitHub Releases (publicada pelo GitHub Actions a cada push: download, SHA-256 e tar) ou,
# sem ela ou com "Compilar a partir deste código", requisitos (Rust, linker C++) -> app\build.ps1 -> app\dist\BlueScreen;
# depois, cópia para a pasta escolhida (robocopy) -> atalhos, desinstalador e registro em Configurações > Apps (HKCU).
# Tudo que demora roda em processo separado; um timer no thread da janela lê a saída e anima o progresso.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 # GitHub só aceita TLS 1.2+
function Fatal([string]$msg) { [Windows.MessageBox]::Show($msg, 'Instalar BlueScreen', 'OK', 'Error') | Out-Null; exit 1 }

$Root = Split-Path -Parent $SetupFile
$App = Join-Path $Root 'app'
if (-not (Test-Path (Join-Path $App 'build.ps1'))) { Fatal "Não encontrei app\build.ps1 ao lado do instalador.`nRode o instalador a partir da raiz do repositório do BlueScreen." }
$Version = if ([IO.File]::ReadAllText((Join-Path $App 'Cargo.toml')) -match 'version\s*=\s*"([^"]+)"') { $Matches[1] } else { '' }
# Releases do repositório (o mesmo do Cargo.toml): a versão pronta mais recente
$ReleasesApi = if ([IO.File]::ReadAllText((Join-Path $App 'Cargo.toml')) -match 'repository\s*=\s*"https://github\.com/([^"/]+/[^"/]+?)/?"') { "https://api.github.com/repos/$($Matches[1])/releases/latest" } else { $null }
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueScreen'

try {
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Instalar BlueScreen" Width="800" Height="560" WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="CenterScreen" FontFamily="Segoe UI Variable Text, Segoe UI" TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <SolidColorBrush x:Key="Fg" Color="#E6EBF4"/>
    <SolidColorBrush x:Key="Muted" Color="#8393B0"/>
    <Style x:Key="Primary" TargetType="Button">
      <Setter Property="Foreground" Value="White"/><Setter Property="FontSize" Value="13"/><Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Padding" Value="22,9"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="B" CornerRadius="9" Padding="{TemplateBinding Padding}" RenderTransformOrigin="0.5,0.5">
          <Border.Background><SolidColorBrush Color="#3D7EF5"/></Border.Background>
          <Border.Effect><DropShadowEffect Color="#3D7EF5" BlurRadius="18" ShadowDepth="0" Opacity="0.45"/></Border.Effect>
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Trigger.EnterActions><BeginStoryboard><Storyboard><ColorAnimation Storyboard.TargetName="B" Storyboard.TargetProperty="(Border.Background).(SolidColorBrush.Color)" To="#5B95FF" Duration="0:0:0.18"/></Storyboard></BeginStoryboard></Trigger.EnterActions>
            <Trigger.ExitActions><BeginStoryboard><Storyboard><ColorAnimation Storyboard.TargetName="B" Storyboard.TargetProperty="(Border.Background).(SolidColorBrush.Color)" To="#3D7EF5" Duration="0:0:0.25"/></Storyboard></BeginStoryboard></Trigger.ExitActions>
          </Trigger>
          <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="RenderTransform"><Setter.Value><ScaleTransform ScaleX="0.97" ScaleY="0.97"/></Setter.Value></Setter></Trigger>
          <Trigger Property="IsEnabled" Value="False"><Setter TargetName="B" Property="Opacity" Value="0.38"/><Setter Property="Cursor" Value="Arrow"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="Secondary" TargetType="Button">
      <Setter Property="Foreground" Value="#C9D3E6"/><Setter Property="FontSize" Value="13"/><Setter Property="Padding" Value="18,9"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="B" CornerRadius="9" Padding="{TemplateBinding Padding}" Background="#12FFFFFF" BorderBrush="#24FFFFFF" BorderThickness="1" RenderTransformOrigin="0.5,0.5">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#22FFFFFF"/><Setter Property="Foreground" Value="White"/></Trigger>
          <Trigger Property="IsPressed" Value="True"><Setter TargetName="B" Property="RenderTransform"><Setter.Value><ScaleTransform ScaleX="0.97" ScaleY="0.97"/></Setter.Value></Setter></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key="Link" TargetType="Button">
      <Setter Property="Foreground" Value="#6CA2FF"/><Setter Property="FontSize" Value="12"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border Background="Transparent" Padding="2"><ContentPresenter/></Border></ControlTemplate></Setter.Value></Setter>
      <Style.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter Property="Foreground" Value="#A8C8FF"/></Trigger></Style.Triggers>
    </Style>
    <Style x:Key="Chrome" TargetType="Button">
      <Setter Property="Foreground" Value="#9FB0CE"/><Setter Property="Width" Value="40"/><Setter Property="Height" Value="32"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
        <Border x:Name="B" Background="Transparent" CornerRadius="7"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
        <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#1AFFFFFF"/><Setter Property="Foreground" Value="White"/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="#DCE3EF"/><Setter Property="FontSize" Value="13"/><Setter Property="Cursor" Value="Hand"/><Setter Property="Margin" Value="0,0,0,10"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="CheckBox">
        <StackPanel Orientation="Horizontal" Background="Transparent">
          <Border x:Name="Box" Width="18" Height="18" CornerRadius="5" BorderThickness="1.5" BorderBrush="#4A5D80" Background="Transparent">
            <Path x:Name="Chk" Data="M3.2,7.6 L6.2,10.6 L11.8,4.6" Stroke="White" StrokeThickness="2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Opacity="0"/>
          </Border>
          <ContentPresenter Margin="10,0,0,0" VerticalAlignment="Center"/>
        </StackPanel>
        <ControlTemplate.Triggers>
          <Trigger Property="IsChecked" Value="True"><Setter TargetName="Box" Property="Background" Value="#3D7EF5"/><Setter TargetName="Box" Property="BorderBrush" Value="#3D7EF5"/><Setter TargetName="Chk" Property="Opacity" Value="1"/></Trigger>
          <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Box" Property="BorderBrush" Value="#6CA2FF"/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Background" Value="#0A1222"/><Setter Property="Foreground" Value="#E6EBF4"/><Setter Property="BorderBrush" Value="#24FFFFFF"/>
      <Setter Property="Padding" Value="10,7"/><Setter Property="FontSize" Value="13"/><Setter Property="CaretBrush" Value="#6CA2FF"/><Setter Property="SelectionBrush" Value="#3D7EF5"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="TextBox">
        <Border x:Name="B" CornerRadius="8" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1">
          <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers><Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="#3D7EF5"/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="8"/><Setter Property="MinWidth" Value="8"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ScrollBar">
        <Track x:Name="PART_Track" IsDirectionReversed="True"><Track.Thumb><Thumb><Thumb.Template><ControlTemplate TargetType="Thumb"><Border CornerRadius="4" Background="#33FFFFFF" Margin="1,0"/></ControlTemplate></Thumb.Template></Thumb></Track.Thumb></Track>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType="ProgressBar">
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="ProgressBar">
        <Grid Height="8">
          <Border x:Name="PART_Track" CornerRadius="4" Background="#16FFFFFF"/>
          <Border x:Name="PART_Indicator" CornerRadius="4" HorizontalAlignment="Left" ClipToBounds="True">
            <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,0"><GradientStop Color="#2F6BE0" Offset="0"/><GradientStop Color="#7FB2FF" Offset="1"/></LinearGradientBrush></Border.Background>
            <Border.Effect><DropShadowEffect Color="#4C8DFF" BlurRadius="14" ShadowDepth="0" Opacity="0.9"/></Border.Effect>
            <Rectangle Width="90" HorizontalAlignment="Left">
              <Rectangle.Fill><LinearGradientBrush StartPoint="0,0" EndPoint="1,0"><GradientStop Color="#00FFFFFF" Offset="0"/><GradientStop Color="#70FFFFFF" Offset="0.5"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></Rectangle.Fill>
              <Rectangle.RenderTransform><TranslateTransform X="-90"/></Rectangle.RenderTransform>
              <Rectangle.Triggers><EventTrigger RoutedEvent="FrameworkElement.Loaded"><BeginStoryboard><Storyboard RepeatBehavior="Forever">
                <DoubleAnimation Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.X)" From="-90" To="520" Duration="0:0:1.7"/>
              </Storyboard></BeginStoryboard></EventTrigger></Rectangle.Triggers>
            </Rectangle>
          </Border>
        </Grid>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>

  <Window.Triggers><EventTrigger RoutedEvent="Window.Loaded"><BeginStoryboard><Storyboard>
    <DoubleAnimation Storyboard.TargetName="Shell" Storyboard.TargetProperty="Opacity" From="0" To="1" Duration="0:0:0.35"/>
    <DoubleAnimation Storyboard.TargetName="ShellScale" Storyboard.TargetProperty="ScaleX" From="0.96" To="1" Duration="0:0:0.45"><DoubleAnimation.EasingFunction><BackEase EasingMode="EaseOut" Amplitude="0.4"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="ShellScale" Storyboard.TargetProperty="ScaleY" From="0.96" To="1" Duration="0:0:0.45"><DoubleAnimation.EasingFunction><BackEase EasingMode="EaseOut" Amplitude="0.4"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="Aura1" Storyboard.TargetProperty="X" From="-40" To="60" Duration="0:0:7" AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="Aura1" Storyboard.TargetProperty="Y" From="-20" To="70" Duration="0:0:9" AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="Aura2" Storyboard.TargetProperty="X" From="50" To="-50" Duration="0:0:8" AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="Aura2" Storyboard.TargetProperty="Y" From="40" To="-60" Duration="0:0:11" AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation.EasingFunction><SineEase EasingMode="EaseInOut"/></DoubleAnimation.EasingFunction></DoubleAnimation>
    <DoubleAnimation Storyboard.TargetName="Smile" Storyboard.TargetProperty="Opacity" From="0.05" To="0.11" Duration="0:0:4" AutoReverse="True" RepeatBehavior="Forever"/>
  </Storyboard></BeginStoryboard></EventTrigger></Window.Triggers>

  <Border x:Name="Shell" Margin="16" CornerRadius="16" BorderBrush="#2A3A5C" BorderThickness="1" RenderTransformOrigin="0.5,0.5" Opacity="0">
    <Border.RenderTransform><ScaleTransform x:Name="ShellScale"/></Border.RenderTransform>
    <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#111C31" Offset="0"/><GradientStop Color="#0B1426" Offset="1"/></LinearGradientBrush></Border.Background>
    <Border.Effect><DropShadowEffect BlurRadius="26" ShadowDepth="4" Opacity="0.55" Color="#02060F"/></Border.Effect>
    <Grid>
      <Grid.ColumnDefinitions><ColumnDefinition Width="268"/><ColumnDefinition/></Grid.ColumnDefinitions>

      <!-- herói: o azul da tela azul, com o sorriso invertido -->
      <Border CornerRadius="15,0,0,15" x:Name="Hero">
        <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="0.6,1"><GradientStop Color="#0B66E4" Offset="0"/><GradientStop Color="#0848B0" Offset="1"/></LinearGradientBrush></Border.Background>
        <Grid ClipToBounds="True">
          <Grid.Clip><RectangleGeometry Rect="0,0,268,600" RadiusX="15" RadiusY="15"/></Grid.Clip>
          <Ellipse Width="260" Height="260" Fill="#5FA8FF" Opacity="0.35" HorizontalAlignment="Left" VerticalAlignment="Top" Margin="-60,-40,0,0">
            <Ellipse.Effect><BlurEffect Radius="70"/></Ellipse.Effect><Ellipse.RenderTransform><TranslateTransform x:Name="Aura1"/></Ellipse.RenderTransform>
          </Ellipse>
          <Ellipse Width="240" Height="240" Fill="#0030A0" Opacity="0.55" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,-80,-40">
            <Ellipse.Effect><BlurEffect Radius="70"/></Ellipse.Effect><Ellipse.RenderTransform><TranslateTransform x:Name="Aura2"/></Ellipse.RenderTransform>
          </Ellipse>
          <TextBlock x:Name="Smile" Text=":)" FontFamily="Segoe UI" FontWeight="Bold" FontSize="250" Foreground="White" Opacity="0.08" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,-18,-62"/>
          <StackPanel Margin="30,40,26,0" VerticalAlignment="Top">
            <Image x:Name="Logo" Width="58" Height="58" HorizontalAlignment="Left">
              <Image.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="3" Opacity="0.45" Color="#001A55"/></Image.Effect>
            </Image>
            <TextBlock Text="BlueScreen" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="30" FontWeight="SemiBold" Foreground="White" Margin="0,22,0,0"/>
            <TextBlock Text="A IDE leve para Windows: editor, Git, terminal, depurador e build num programa de poucos MB." TextWrapping="Wrap" Foreground="#D6E6FF" FontSize="13" LineHeight="20" Margin="0,8,0,0"/>
          </StackPanel>
          <Border VerticalAlignment="Bottom" HorizontalAlignment="Left" Margin="30,0,0,28" CornerRadius="10" Background="#26FFFFFF" Padding="10,4">
            <TextBlock x:Name="VersionTxt" Foreground="White" FontSize="11.5"/>
          </Border>
        </Grid>
      </Border>

      <!-- conteúdo -->
      <Grid Grid.Column="1">
        <Grid.RowDefinitions><RowDefinition Height="40"/><RowDefinition/></Grid.RowDefinitions>
        <Grid x:Name="TitleBar" Background="Transparent">
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,4,6,0">
            <Button x:Name="BtnMin" Style="{StaticResource Chrome}"><Path Data="M0,0 L10,0" Stroke="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}" StrokeThickness="1.2"/></Button>
            <Button x:Name="BtnClose" Style="{StaticResource Chrome}"><Path Data="M0,0 L10,10 M10,0 L0,10" Stroke="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}" StrokeThickness="1.2"/></Button>
          </StackPanel>
        </Grid>

        <!-- 1. configurar -->
        <Grid x:Name="PageSetup" Grid.Row="1" Margin="34,0,34,28">
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <StackPanel>
            <TextBlock Text="Instalar o BlueScreen" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="25" FontWeight="SemiBold" Foreground="{StaticResource Fg}"/>
            <TextBlock Text="Baixa a versão pronta mais recente (ou compila a partir do código desta pasta) e instala só para o seu usuário, sem pedir administrador." TextWrapping="Wrap" Foreground="{StaticResource Muted}" FontSize="13" Margin="0,6,0,0"/>
            <TextBlock Text="PASTA DE INSTALAÇÃO" Foreground="#6F82A6" FontSize="10.5" FontWeight="SemiBold" Margin="0,22,0,7"/>
            <Grid>
              <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <TextBox x:Name="PathBox" FontFamily="Cascadia Mono, Consolas" FontSize="12"/>
              <Button x:Name="BtnBrowse" Grid.Column="1" Style="{StaticResource Secondary}" Content="Alterar…" Margin="8,0,0,0" Padding="14,7"/>
            </Grid>
            <StackPanel Margin="0,16,0,0">
              <CheckBox x:Name="OptDesktop" Content="Atalho na área de trabalho" IsChecked="True"/>
              <CheckBox x:Name="OptMenu" Content="Atalho no menu Iniciar" IsChecked="True"/>
              <CheckBox x:Name="OptBuild" Content="Compilar a partir deste código (em vez de baixar a versão pronta)" IsChecked="False"/>
            </StackPanel>
            <Grid Margin="0,8,0,7">
              <TextBlock Text="REQUISITOS" Foreground="#6F82A6" FontSize="10.5" FontWeight="SemiBold"/>
              <Button x:Name="BtnRecheck" Style="{StaticResource Link}" Content="Verificar de novo" HorizontalAlignment="Right" FontSize="11.5"/>
            </Grid>
            <Border CornerRadius="10" Background="#0C1528" BorderBrush="#1AFFFFFF" BorderThickness="1" Padding="14,8">
              <StackPanel x:Name="ReqList"/>
            </Border>
          </StackPanel>
          <Grid Grid.Row="2">
            <TextBlock x:Name="SetupNote" VerticalAlignment="Center" Foreground="{StaticResource Muted}" FontSize="12" TextWrapping="Wrap" Margin="0,0,16,0" MaxWidth="250" HorizontalAlignment="Left"/>
            <Button x:Name="BtnInstall" Style="{StaticResource Primary}" Content="Instalar" HorizontalAlignment="Right"/>
          </Grid>
        </Grid>

        <!-- 2. instalando -->
        <Grid x:Name="PageWork" Grid.Row="1" Margin="34,0,34,28" Visibility="Collapsed">
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <StackPanel>
            <TextBlock x:Name="WorkTitle" Text="Instalando…" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="25" FontWeight="SemiBold" Foreground="{StaticResource Fg}"/>
            <TextBlock x:Name="WorkSub" Text="Na primeira vez a compilação leva alguns minutos. Pode deixar rodando." TextWrapping="Wrap" Foreground="{StaticResource Muted}" FontSize="13" Margin="0,6,0,0"/>
            <Grid Margin="0,22,0,10">
              <TextBlock x:Name="Percent" Text="0%" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="40" FontWeight="Light" Foreground="White"/>
              <TextBlock x:Name="Elapsed" Text="00:00" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,0,8" Foreground="{StaticResource Muted}" FontFamily="Cascadia Mono, Consolas" FontSize="12"/>
            </Grid>
            <ProgressBar x:Name="Bar" Minimum="0" Maximum="1000" Value="0"/>
            <TextBlock x:Name="CurLine" Margin="0,10,0,0" Foreground="#6F82A6" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" TextTrimming="CharacterEllipsis"/>
          </StackPanel>
          <Grid Grid.Row="1" Margin="0,18,0,12">
            <StackPanel x:Name="StepList"/>
            <TextBox x:Name="LogBox" Visibility="Collapsed" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" FontFamily="Cascadia Mono, Consolas" FontSize="11" Foreground="#A9B6CC" VerticalContentAlignment="Top"/>
          </Grid>
          <Grid Grid.Row="2">
            <Button x:Name="BtnDetails" Style="{StaticResource Link}" Content="Ver detalhes" HorizontalAlignment="Left" VerticalAlignment="Center"/>
            <Button x:Name="BtnCancel" Style="{StaticResource Secondary}" Content="Cancelar" HorizontalAlignment="Right"/>
          </Grid>
        </Grid>

        <!-- 3. pronto -->
        <Grid x:Name="PageDone" Grid.Row="1" Margin="34,0,34,28" Visibility="Collapsed">
          <Grid.RowDefinitions><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <StackPanel VerticalAlignment="Center" Margin="0,0,0,20">
            <Grid Width="96" Height="96" HorizontalAlignment="Center">
              <Ellipse x:Name="Ripple" Stroke="#3FB950" StrokeThickness="2" RenderTransformOrigin="0.5,0.5" Opacity="0"><Ellipse.RenderTransform><ScaleTransform x:Name="RippleS"/></Ellipse.RenderTransform></Ellipse>
              <Grid x:Name="Badge" RenderTransformOrigin="0.5,0.5">
                <Grid.RenderTransform><ScaleTransform x:Name="BadgeS" ScaleX="0" ScaleY="0"/></Grid.RenderTransform>
                <Ellipse><Ellipse.Fill><LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#3FB950" Offset="0"/><GradientStop Color="#238636" Offset="1"/></LinearGradientBrush></Ellipse.Fill>
                  <Ellipse.Effect><DropShadowEffect Color="#3FB950" BlurRadius="30" ShadowDepth="0" Opacity="0.6"/></Ellipse.Effect></Ellipse>
                <Path x:Name="Check" Data="M28,49 L42,63 L68,35" Stroke="White" StrokeThickness="6" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" StrokeDashArray="12 12" StrokeDashOffset="12"/>
              </Grid>
            </Grid>
            <TextBlock Text="Tudo pronto!" HorizontalAlignment="Center" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="26" FontWeight="SemiBold" Foreground="{StaticResource Fg}" Margin="0,22,0,0"/>
            <TextBlock Text="O BlueScreen foi instalado em" HorizontalAlignment="Center" Foreground="{StaticResource Muted}" FontSize="13" Margin="0,8,0,4"/>
            <TextBlock x:Name="DonePath" HorizontalAlignment="Center" Foreground="#C9D3E6" FontFamily="Cascadia Mono, Consolas" FontSize="12" TextTrimming="CharacterEllipsis"/>
            <TextBlock x:Name="DoneNote" HorizontalAlignment="Center" Foreground="#6F82A6" FontSize="11.5" Margin="0,14,0,0" TextAlignment="Center" TextWrapping="Wrap"/>
          </StackPanel>
          <StackPanel Grid.Row="1" Orientation="Horizontal" HorizontalAlignment="Right">
            <Button x:Name="BtnDoneClose" Style="{StaticResource Secondary}" Content="Fechar" Margin="0,0,10,0"/>
            <Button x:Name="BtnLaunch" Style="{StaticResource Primary}" Content="Abrir o BlueScreen"/>
          </StackPanel>
        </Grid>

        <!-- 4. falhou -->
        <Grid x:Name="PageFail" Grid.Row="1" Margin="34,0,34,28" Visibility="Collapsed">
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <StackPanel>
            <StackPanel Orientation="Horizontal">
              <Grid Width="34" Height="34" Margin="0,0,12,0"><Ellipse Fill="#33F0606E"/><TextBlock Text="!" Foreground="#FF7B86" FontSize="20" FontWeight="Bold" HorizontalAlignment="Center" VerticalAlignment="Center"/></Grid>
              <TextBlock x:Name="FailTitle" Text="A instalação não terminou" VerticalAlignment="Center" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="23" FontWeight="SemiBold" Foreground="{StaticResource Fg}"/>
            </StackPanel>
            <TextBlock x:Name="FailMsg" TextWrapping="Wrap" Foreground="#C9D3E6" FontSize="13" Margin="0,14,0,0" LineHeight="19"/>
          </StackPanel>
          <TextBox x:Name="FailLog" Grid.Row="1" Margin="0,14,0,14" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" FontFamily="Cascadia Mono, Consolas" FontSize="11" Foreground="#A9B6CC" VerticalContentAlignment="Top"/>
          <Grid Grid.Row="2">
            <Button x:Name="BtnCopyLog" Style="{StaticResource Link}" Content="Copiar o log completo" HorizontalAlignment="Left" VerticalAlignment="Center"/>
            <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
              <Button x:Name="BtnFailClose" Style="{StaticResource Secondary}" Content="Fechar" Margin="0,0,10,0"/>
              <Button x:Name="BtnRetry" Style="{StaticResource Primary}" Content="Tentar de novo"/>
            </StackPanel>
          </Grid>
        </Grid>
      </Grid>
    </Grid>
  </Border>
</Window>
'@
$win = [Windows.Markup.XamlReader]::Parse($xaml)
$ui = @{}
foreach ($m in [regex]::Matches($xaml, 'x:Name="(\w+)"')) { $el = $win.FindName($m.Groups[1].Value); if ($el) { $ui[$m.Groups[1].Value] = $el } }
} catch { Fatal "A janela do instalador não abriu:`n$($_.Exception.Message)" }

# ----- utilidades de animação e cor -----
$BC = [Windows.Media.BrushConverter]::new()
function Brush([string]$hex) { $BC.ConvertFromString($hex) }
function Dur([double]$ms) { [Windows.Duration]::new([TimeSpan]::FromMilliseconds($ms)) }
function Anim([double]$from, [double]$to, [double]$ms, $ease) {
  $a = [Windows.Media.Animation.DoubleAnimation]::new($from, $to, (Dur $ms)); if ($ease) { $a.EasingFunction = $ease }; $a
}
function EaseOut { $e = [Windows.Media.Animation.CubicEase]::new(); $e.EasingMode = 'EaseOut'; $e }
function BackOut([double]$amp = 0.5) { $e = [Windows.Media.Animation.BackEase]::new(); $e.EasingMode = 'EaseOut'; $e.Amplitude = $amp; $e }

$Pages = 'PageSetup', 'PageWork', 'PageDone', 'PageFail'
function Show-Page([string]$name) {
  foreach ($p in $Pages) { $ui[$p].Visibility = if ($p -eq $name) { 'Visible' } else { 'Collapsed' } }
  $el = $ui[$name]; $tt = [Windows.Media.TranslateTransform]::new(0, 16); $el.RenderTransform = $tt
  $el.BeginAnimation([Windows.UIElement]::OpacityProperty, (Anim 0 1 380 (EaseOut)))
  $tt.BeginAnimation([Windows.Media.TranslateTransform]::YProperty, (Anim 16 0 460 (EaseOut)))
}

# ----- estado -----
$S = @{ phase = 'idle'; proc = $null; reader = $null; task = $null; log = [Text.StringBuilder]::new(); lines = [Collections.Generic.List[string]]::new()
        target = 0.0; shown = 0.0; compiled = 0; total = 300; sw = [Diagnostics.Stopwatch]::new(); dest = ''; cargo = $null; files = 1; copied = 0; deadline = $null
        rustupProc = $null; rustupDl = $null; release = $null; relTask = $null; relError = ''; mode = 'build'; dl = $null; dlFile = ''; src = ''; instVersion = $Version }
$lock = Join-Path $App 'Cargo.lock'
if (Test-Path $lock) { $S.total = [Math]::Max(120, [int](([regex]::Matches([IO.File]::ReadAllText($lock), '(?m)^\[\[package\]\]')).Count * 0.8)) }

$ui.VersionTxt.Text = if ($Version) { "versão $Version" } else { 'BlueScreen' }
try { $ui.Logo.Source = [Windows.Media.Imaging.BitmapImage]::new([Uri](Join-Path $Root 'assets\bluescreen.png')) } catch {}
try { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri](Join-Path $Root 'assets\bluescreen.ico')) } catch {}

# ----- pasta de instalação -----
# Nunca espalha arquivos numa pasta alheia: pasta com conteúdo que não é um BlueScreen instalado ganha \BlueScreen.
function Resolve-InstallDir([string]$d) {
  $d = $d.Trim().TrimEnd('\')
  if ((Test-Path -LiteralPath $d) -and (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue | Select-Object -First 1) -and -not (Test-Path -LiteralPath (Join-Path $d 'BlueScreen.exe'))) { return Join-Path $d 'BlueScreen' }
  $d
}
$prev = (Get-ItemProperty $UninstKey -ErrorAction SilentlyContinue).InstallLocation
$ui.PathBox.Text = if ($prev) { $prev } else { Join-Path $env:LOCALAPPDATA 'Programs\BlueScreen' }
$ui.BtnBrowse.Add_Click({
  $dlg = [Windows.Forms.FolderBrowserDialog]::new(); $dlg.Description = 'Onde instalar o BlueScreen?'; $dlg.ShowNewFolderButton = $true
  $cur = $ui.PathBox.Text; while ($cur -and -not (Test-Path -LiteralPath $cur)) { $cur = Split-Path $cur }; if ($cur) { $dlg.SelectedPath = $cur }
  if ($dlg.ShowDialog() -eq 'OK') { $ui.PathBox.Text = Resolve-InstallDir $dlg.SelectedPath }
})

# ----- requisitos -----
$reqXaml = @'
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Margin="0,5">
  <Grid.ColumnDefinitions><ColumnDefinition Width="18"/><ColumnDefinition Width="Auto"/><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
  <Ellipse Name="Dot" Width="8" Height="8" HorizontalAlignment="Left" VerticalAlignment="Center"/>
  <TextBlock Name="Nm" Grid.Column="1" Foreground="#DCE3EF" FontSize="13" VerticalAlignment="Center"/>
  <TextBlock Name="Det" Grid.Column="2" Margin="10,0,8,0" Foreground="#7F8DA8" FontSize="12" TextTrimming="CharacterEllipsis" VerticalAlignment="Center"/>
  <Button Name="Act" Grid.Column="3" Style="{DynamicResource Link}" Visibility="Collapsed" VerticalAlignment="Center"/>
</Grid>
'@
$Req = @{}
foreach ($id in 'release', 'rust', 'linker', 'webview') {
  $g = [Windows.Markup.XamlReader]::Parse($reqXaml); $ui.ReqList.Children.Add($g) | Out-Null
  $Req[$id] = @{ root = $g; Dot = $g.FindName('Dot'); Nm = $g.FindName('Nm'); Det = $g.FindName('Det'); Act = $g.FindName('Act') }
}
function Set-Req([string]$id, [string]$name, [string]$state, [string]$detail, [string]$action, [scriptblock]$onAct) {
  $r = $Req[$id]; $r.Nm.Text = $name; $r.Det.Text = $detail; $r.Det.ToolTip = $detail
  $color = @{ ok = '#3FB950'; warn = '#E3A63A'; bad = '#F0606E'; busy = '#6CA2FF' }[$state]
  $r.Dot.Fill = Brush $color
  $r.Dot.Effect = [Windows.Media.Effects.DropShadowEffect]@{ Color = [Windows.Media.ColorConverter]::ConvertFromString($color); BlurRadius = 8; ShadowDepth = 0; Opacity = 0.9 }
  $r.Act.Visibility = if ($action) { 'Visible' } else { 'Collapsed' }
  $r.Act.Content = $action; $r.ActHandler = $onAct
}
foreach ($id in $Req.Keys) { $Req[$id].Act.Add_Click({ param($s, $e) foreach ($k in $Req.Keys) { if ($Req[$k].Act -eq $s -and $Req[$k].ActHandler) { & $Req[$k].ActHandler } } }) }
$Req.linker.root.Visibility = 'Collapsed'

# ----- versão pronta (GitHub Releases) -----
function New-Web { $w = [Net.WebClient]::new(); $w.Headers['User-Agent'] = 'BlueScreen-Setup'; $w.Encoding = [Text.Encoding]::UTF8; $w }
function Start-ReleaseCheck {
  $S.release = $null; $S.relError = ''
  if (-not $ReleasesApi) { $S.relError = 'o Cargo.toml não aponta um repositório do GitHub'; return }
  Set-Req release 'Versão pronta' busy 'procurando no GitHub…'
  $w = New-Web; $w.Headers['Accept'] = 'application/vnd.github+json'
  $S.relTask = $w.DownloadStringTaskAsync($ReleasesApi)
}
function On-ReleaseCheck {
  $t = $S.relTask; $S.relTask = $null
  if ($t.IsFaulted) { $S.relError = $t.Exception.InnerException.Message }
  else {
    $r = $t.Result | ConvertFrom-Json
    $zip = @($r.assets | Where-Object { $_.name -like '*-windows-x64.zip' })[0]
    if ($zip) {
      $sha = @($r.assets | Where-Object { $_.name -eq "$($zip.name).sha256" })[0]
      $S.release = @{ version = ($r.tag_name -replace '^v', ''); url = $zip.browser_download_url; size = [long]$zip.size; name = $zip.name
                      digest = $zip.digest; shaUrl = $(if ($sha) { $sha.browser_download_url }) }
    } else { $S.relError = "$($r.tag_name) não tem o pacote para Windows" }
  }
  Test-Requirements
}

function Find-Cargo {
  $c = Get-Command cargo -ErrorAction SilentlyContinue; if ($c) { return $c.Source }
  $p = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'; if (Test-Path $p) { return $p }
}
function Test-Requirements {
  $S.cargo = Find-Cargo
  $dl = $S.release -and -not $ui.OptBuild.IsChecked
  if ($S.relTask) { }
  elseif ($S.release) { Set-Req release 'Versão pronta' ok ("v$($S.release.version) · {0:N1} MB · sem compilar" -f ($S.release.size / 1MB)) }
  else { Set-Req release 'Versão pronta' warn ("indisponível ($($S.relError)): compila a partir do código") 'Tentar de novo' { Start-ReleaseCheck } }
  if ($S.cargo) {
    $ver = try { ((& $S.cargo --version) -replace '^cargo\s+', '' -split ' ')[0] } catch { '' }
    $rustc = Join-Path (Split-Path $S.cargo) 'rustc.exe'
    $hostTriple = try { ((& $rustc -vV) | Where-Object { $_ -like 'host:*' }) -replace 'host:\s*', '' } catch { '' }
    Set-Req rust 'Rust' ok ("cargo $ver" + $(if ($hostTriple) { " · $hostTriple" }))
    if ($hostTriple -like '*msvc*') {
      $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
      $vc = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath } else { $null }
      $Req.linker.root.Visibility = 'Visible'
      if ($vc) { Set-Req linker 'Linker C++ (MSVC)' ok 'Build Tools do Visual Studio' }
      else { Set-Req linker 'Linker C++ (MSVC)' warn 'Build Tools do Visual Studio não encontrados' 'Baixar' { Start-Process 'https://visualstudio.microsoft.com/visual-cpp-build-tools/' } }
    } else { $Req.linker.root.Visibility = 'Collapsed' }
  } else {
    $Req.linker.root.Visibility = 'Collapsed'
    Set-Req rust 'Rust' $(if ($dl) { 'ok' } else { 'bad' }) $(if ($dl) { 'não precisa: a versão pronta já vem compilada' } else { 'não encontrado: é preciso para compilar' }) 'Instalar Rust' { Install-Rust }
  }
  $wv = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $pv = foreach ($k in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv") {
    $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv; if ($v -and $v -ne '0.0.0.0') { $v; break } }
  if ($pv) { Set-Req webview 'WebView2' ok "runtime $pv" }
  else { Set-Req webview 'WebView2' warn 'runtime não encontrado (o app não abre sem ele)' 'Baixar' { Start-Process 'https://developer.microsoft.com/microsoft-edge/webview2/' } }
  $ui.BtnInstall.IsEnabled = [bool]($dl -or $S.cargo) -and -not $S.relTask
  $ui.SetupNote.Text = if ($S.relTask) { 'Procurando a versão pronta…' }
                       elseif ($dl) { "Baixa a v$($S.release.version) pronta: menos de um minuto." }
                       elseif (-not $S.cargo) { 'Instale o Rust para continuar. O instalador dele abre numa janela própria.' }
                       elseif (Test-Path (Join-Path $App 'target\release\bluescreen.exe')) { 'Já há uma compilação anterior: deve ser rápido.' }
                       else { 'Primeira compilação: leva de 3 a 10 minutos.' }
}
# rustup-init oficial: baixa sem travar a janela e abre o instalador dele (interativo, oferece o linker do Visual Studio)
function Install-Rust {
  $exe = Join-Path $env:TEMP 'rustup-init.exe'
  Set-Req rust 'Rust' busy 'baixando o rustup-init…'
  $wc = [Net.WebClient]::new(); $S.rustupDl = $wc.DownloadFileTaskAsync('https://win.rustup.rs/x86_64', $exe); $S.rustupExe = $exe
  $S.phase = 'rustup-dl'; $ui.BtnInstall.IsEnabled = $false
}
$ui.BtnRecheck.Add_Click({ if (-not $S.release) { Start-ReleaseCheck }; Test-Requirements })
$ui.OptBuild.Add_Click({ Test-Requirements })

# ----- etapas -----
$stepXaml = @'
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Margin="0,0,0,11">
  <Grid.ColumnDefinitions><ColumnDefinition Width="32"/><ColumnDefinition/></Grid.ColumnDefinitions>
  <Grid Width="20" Height="20" HorizontalAlignment="Left">
    <Ellipse Name="Ring" Stroke="#33476B" StrokeThickness="1.5"/>
    <Path Name="Arc" Stroke="#6CA2FF" StrokeThickness="2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Data="M10,1 A9,9 0 0 1 19,10" RenderTransformOrigin="0.5,0.5" Visibility="Collapsed"><Path.RenderTransform><RotateTransform/></Path.RenderTransform></Path>
    <Grid Name="Ok" Visibility="Collapsed" RenderTransformOrigin="0.5,0.5"><Grid.RenderTransform><ScaleTransform/></Grid.RenderTransform>
      <Ellipse Fill="#2EA043"/><Path Data="M5.8,10.4 L8.7,13.2 L14.3,7.2" Stroke="White" StrokeThickness="2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/></Grid>
    <Grid Name="Bad" Visibility="Collapsed"><Ellipse Fill="#DA3633"/><Path Data="M7,7 L13,13 M13,7 L7,13" Stroke="White" StrokeThickness="2" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/></Grid>
  </Grid>
  <TextBlock Name="Txt" Grid.Column="1" VerticalAlignment="Center" FontSize="13.5"/>
</Grid>
'@
$Steps = @()
foreach ($t in 'Preparar', 'Compilar o BlueScreen', 'Montar a versão final', 'Copiar para a pasta de instalação', 'Criar atalhos e o desinstalador') {
  $g = [Windows.Markup.XamlReader]::Parse($stepXaml); $ui.StepList.Children.Add($g) | Out-Null
  $st = @{ root = $g; Txt = $g.FindName('Txt') }; foreach ($n in 'Ring', 'Arc', 'Ok', 'Bad') { $st[$n] = $g.FindName($n) }
  $st.Txt.Text = $t; $Steps += $st
}
function Set-Step([int]$i, [string]$state) {
  $s = $Steps[$i]; foreach ($n in 'Ring', 'Arc', 'Ok', 'Bad') { $s[$n].Visibility = 'Collapsed' }
  $s.Arc.RenderTransform.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, $null)
  $s.Txt.FontWeight = 'Normal'
  switch ($state) {
    'wait' { $s.Ring.Visibility = 'Visible'; $s.Txt.Foreground = Brush '#5E6E8C' }
    'run' {
      $s.Ring.Visibility = 'Visible'; $s.Arc.Visibility = 'Visible'; $s.Txt.Foreground = Brush '#FFFFFF'; $s.Txt.FontWeight = 'SemiBold'
      $a = Anim 0 360 850 $null; $a.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
      $s.Arc.RenderTransform.BeginAnimation([Windows.Media.RotateTransform]::AngleProperty, $a)
    }
    'ok' {
      $s.Ok.Visibility = 'Visible'; $s.Txt.Foreground = Brush '#9AA9C4'
      foreach ($p in [Windows.Media.ScaleTransform]::ScaleXProperty, [Windows.Media.ScaleTransform]::ScaleYProperty) { $s.Ok.RenderTransform.BeginAnimation($p, (Anim 0.3 1 420 (BackOut 0.7))) }
    }
    'bad' { $s.Bad.Visibility = 'Visible'; $s.Txt.Foreground = Brush '#FF9AA2' }
  }
}
function Set-StepNames {
  $names = if ($S.mode -eq 'download') { 'Preparar', "Baixar a versão $($S.instVersion)", 'Conferir (SHA-256) e extrair', 'Copiar para a pasta de instalação', 'Criar atalhos e o desinstalador' }
           else { 'Preparar', 'Compilar o BlueScreen', 'Montar a versão final', 'Copiar para a pasta de instalação', 'Criar atalhos e o desinstalador' }
  for ($k = 0; $k -lt $Steps.Count; $k++) { $Steps[$k].Txt.Text = $names[$k] }
}
function Go-Step([int]$i) { for ($k = 0; $k -lt $Steps.Count; $k++) { if ($k -lt $i) { if ($Steps[$k].Ok.Visibility -ne 'Visible') { Set-Step $k ok } } elseif ($k -eq $i) { Set-Step $k run } else { Set-Step $k wait } }; $S.step = $i }

function Add-Log([string]$line) {
  [void]$S.log.AppendLine($line); $S.lines.Add($line)
  if ($ui.LogBox.Visibility -eq 'Visible') { $ui.LogBox.AppendText($line + "`n"); $ui.LogBox.ScrollToEnd() }
}
function Set-Target([double]$p) { if ($p -gt $S.target) { $S.target = [Math]::Min(1, $p) } }

# ----- processos (saída lida sem travar a janela) -----
function Start-Reader([string]$file, [string]$arguments, [Text.Encoding]$enc) {
  $psi = [Diagnostics.ProcessStartInfo]::new($file, $arguments)
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $App
  $psi.StandardOutputEncoding = $enc
  $psi.EnvironmentVariables['CARGO_TERM_COLOR'] = 'never'
  if ($S.cargo) { $psi.EnvironmentVariables['PATH'] = (Split-Path $S.cargo) + ';' + $psi.EnvironmentVariables['PATH'] }
  $S.proc = [Diagnostics.Process]::Start($psi); $S.reader = $S.proc.StandardOutput; $S.task = $S.reader.ReadLineAsync()
}
# lê as linhas que já chegaram; devolve $true quando a saída acabou
function Pump([scriptblock]$onLine) {
  $n = 0
  while ($S.task -and $S.task.IsCompleted -and $n -lt 300) {
    $line = $S.task.Result
    if ($null -eq $line) { $S.task = $null; return $true }
    Add-Log $line; & $onLine $line; $n++
    $S.task = $S.reader.ReadLineAsync()
  }
  return $false
}
function Stop-Proc { if ($S.proc -and -not $S.proc.HasExited) { & taskkill.exe /PID $S.proc.Id /T /F 2>$null | Out-Null }; $S.proc = $null; $S.task = $null }

function Get-Running {
  Get-Process BlueScreen -ErrorAction SilentlyContinue | Where-Object {
    $p = $_.Path; $p -and ($p.StartsWith($S.dest + '\', 'OrdinalIgnoreCase') -or $p.StartsWith((Join-Path $App 'dist') + '\', 'OrdinalIgnoreCase')) }
}

# ----- instalar -----
function Start-Install {
  $d = Resolve-InstallDir $ui.PathBox.Text
  if (-not $d -or -not [IO.Path]::IsPathRooted($d)) { [Windows.MessageBox]::Show('Escolha uma pasta de instalação válida.', 'Instalar BlueScreen') | Out-Null; return }
  $full = [IO.Path]::GetFullPath($d); $rootFull = [IO.Path]::GetFullPath($Root)
  # a pasta final (com o \BlueScreen acrescentado) é a que o robocopy /MIR espelha: com arquivos que não são de um
  # BlueScreen instalado, ele os apagaria
  if ((Test-Path -LiteralPath $full) -and (Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue | Select-Object -First 1) -and -not (Test-Path -LiteralPath (Join-Path $full 'BlueScreen.exe'))) { [Windows.MessageBox]::Show("A pasta $full já tem arquivos que não são de um BlueScreen instalado.`nEscolha uma pasta vazia ou a de uma instalação anterior.", 'Instalar BlueScreen') | Out-Null; return }
  if (($full.TrimEnd('\') + '\').StartsWith($rootFull.TrimEnd('\') + '\', 'OrdinalIgnoreCase')) { [Windows.MessageBox]::Show('Instale fora da pasta do código-fonte (o build apaga e recria app\dist).', 'Instalar BlueScreen') | Out-Null; return }
  $ui.PathBox.Text = $full; $S.dest = $full
  $S.mode = if ($S.release -and -not $ui.OptBuild.IsChecked) { 'download' } else { 'build' }
  $S.instVersion = if ($S.mode -eq 'download') { $S.release.version } else { $Version }; Set-StepNames
  $S.log.Clear() | Out-Null; $S.lines.Clear(); $ui.LogBox.Clear(); $S.target = 0; $S.shown = 0; $S.compiled = 0
  $ui.Bar.Value = 0; $ui.Percent.Text = '0%'; $ui.CurLine.Text = ''; $ui.WorkTitle.Text = 'Instalando…'
  $ui.BtnCancel.IsEnabled = $true
  Show-Page PageWork; Go-Step 0; $S.sw.Restart()
  Add-Log "Instalando BlueScreen $($S.instVersion) em $full ($(if ($S.mode -eq 'download') { 'versão pronta do GitHub' } else { 'compilando deste código' }))"
  $running = @(Get-Running)
  if ($running) {
    $ui.CurLine.Text = 'Fechando o BlueScreen aberto…'
    $running | ForEach-Object { [void]$_.CloseMainWindow() }
    $S.deadline = (Get-Date).AddSeconds(12); $S.phase = 'closing'
  } else { Start-Work }
}
function Start-Work { if ($S.mode -eq 'download') { Start-Download } else { Start-Build } }
# ----- versão pronta: baixar, conferir a soma e extrair -----
function Start-Download {
  Go-Step 1; Set-Target 0.03; $S.phase = 'download'
  $dir = Join-Path $env:TEMP 'bluescreen-setup'
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $S.dlFile = Join-Path $dir $S.release.name; $S.src = Join-Path $dir 'BlueScreen'
  Add-Log "baixando $($S.release.url)"
  $S.dl = (New-Web).DownloadFileTaskAsync($S.release.url, $S.dlFile)
}
function On-DownloadTick {
  $got = if (Test-Path $S.dlFile) { (Get-Item $S.dlFile).Length } else { 0 }
  $p = [Math]::Min(1, $got / [Math]::Max(1, $S.release.size))
  $ui.CurLine.Text = '{0:N1} de {1:N1} MB' -f ($got / 1MB), ($S.release.size / 1MB); Set-Target (0.03 + 0.67 * $p)
  if (-not $S.dl.IsCompleted) { return }
  if ($S.dl.IsFaulted) { Fail-Install ('O download falhou: ' + $S.dl.Exception.InnerException.Message + '. Marque "Compilar a partir deste código" para instalar sem baixar.'); return }
  Go-Step 2; Set-Target 0.72; $ui.CurLine.Text = 'conferindo a soma SHA-256'
  $want = if ($S.release.digest -like 'sha256:*') { $S.release.digest.Substring(7) }
          elseif ($S.release.shaUrl) { ((New-Web).DownloadString($S.release.shaUrl) -split '\s+')[0] }
  $have = (Get-FileHash $S.dlFile -Algorithm SHA256).Hash
  if (-not $want) { Fail-Install 'O Release não publica a soma SHA-256 do pacote; por segurança, nada foi instalado.'; return }
  if ($want -ne $have) { Fail-Install "O pacote baixado não confere com a soma publicada (esperado $want, veio $have). Nada foi instalado."; return }
  Add-Log "sha256 conferido: $($have.ToLower())"
  New-Item -ItemType Directory -Force $S.src | Out-Null
  $S.phase = 'extract'; $ui.CurLine.Text = 'extraindo'
  Start-Reader 'tar.exe' "-xf `"$($S.dlFile)`" -C `"$($S.src)`"" ([Text.Encoding]::UTF8)
}
function Start-Build {
  Go-Step 1; Set-Target 0.03; $S.phase = 'build'; $S.src = Join-Path $App 'dist\BlueScreen'
  $ps1 = Join-Path $App 'build.ps1'
  # chcp 65001: o powershell filho escreve UTF-8 (acentos do build.ps1); 2>&1: o cargo escreve o progresso no stderr
  Start-Reader 'cmd.exe' "/d /s /c `"chcp 65001 >nul & powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1`" 2>&1`"" ([Text.UTF8Encoding]::new($false))
}
function On-BuildLine([string]$l) {
  if ($l -match '^\s*Compiling\s+(\S+)\s+v?(\S+)') {
    $S.compiled++; $ui.CurLine.Text = "compilando $($Matches[1]) $($Matches[2])"
    Set-Target (0.03 + 0.79 * [Math]::Min(1, $S.compiled / $S.total))
  } elseif ($l -match '^\s*Finished') { Go-Step 2; Set-Target 0.84; $ui.CurLine.Text = 'montando app\dist\BlueScreen' }
  elseif ($l.Trim()) { $ui.CurLine.Text = $l.Trim() }
}
function Start-Copy {
  Go-Step 3; Set-Target 0.88; $S.phase = 'copy'
  $src = $S.src
  $S.files = [Math]::Max(1, @(Get-ChildItem -LiteralPath $src -Recurse -File).Count); $S.copied = 0
  $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  # /MIR deixa a pasta igual à versão nova (remove arquivos de versões antigas); a pasta é só do BlueScreen (Resolve-InstallDir)
  Start-Reader 'robocopy.exe' "`"$src`" `"$($S.dest)`" /MIR /R:2 /W:1 /NP /NJH /NJS /NDL /NC /NS /XF Desinstalar.cmd source.txt" $oem
}
function On-CopyLine([string]$l) {
  if ($l.Trim()) { $S.copied++; $ui.CurLine.Text = 'copiando ' + (Split-Path $l.Trim() -Leaf); Set-Target (0.88 + 0.08 * [Math]::Min(1, $S.copied / $S.files)) }
}
function Finish-Install {
  Go-Step 4; $S.phase = 'finish'
  $dest = $S.dest; $exe = Join-Path $dest 'BlueScreen.exe'
  $sh = New-Object -ComObject WScript.Shell
  $lnkDesk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'BlueScreen.lnk'
  $lnkMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'BlueScreen.lnk'
  foreach ($pair in @(@($ui.OptDesktop.IsChecked, $lnkDesk), @($ui.OptMenu.IsChecked, $lnkMenu))) {
    if ($pair[0]) { $l = $sh.CreateShortcut($pair[1]); $l.TargetPath = $exe; $l.WorkingDirectory = $dest; $l.IconLocation = "$exe,0"; $l.Description = 'BlueScreen IDE'; $l.Save(); Add-Log "atalho: $($pair[1])" }
    elseif (Test-Path -LiteralPath $pair[1]) { Remove-Item -LiteralPath $pair[1] -Force }
  }
  # desinstalador: remove atalhos, registro e a pasta; as configurações em ~\.bluescreen ficam
  $un = @"
@echo off
chcp 65001 >nul
setlocal
set "DIR=$dest"
tasklist /FI "IMAGENAME eq BlueScreen.exe" 2>nul | find /I "BlueScreen.exe" >nul && (echo Feche o BlueScreen antes de desinstalar.& pause & exit /b 1)
choice /C SN /M "Remover o BlueScreen de %DIR%? (suas configuracoes em %USERPROFILE%\.bluescreen ficam)"
if errorlevel 2 exit /b 0
del /q "$lnkDesk" 2>nul
del /q "$lnkMenu" 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BlueScreen" /f >nul 2>&1
"%DIR%\BlueScreen.exe" --unregister >nul 2>&1
cd /d "%TEMP%"
echo BlueScreen removido.
timeout /t 2 >nul 2>&1
(goto) 2>nul & rmdir /s /q "%DIR%"
"@
  [IO.File]::WriteAllText((Join-Path $dest 'Desinstalar.cmd'), ($un -replace "`r?`n", "`r`n"), [Text.UTF8Encoding]::new($false))
  # de onde veio: o atualizador da IDE (Procurar atualizações) faz git pull e recompila a partir desta pasta
  [IO.File]::WriteAllText((Join-Path $dest 'source.txt'), $Root, [Text.UTF8Encoding]::new($false))
  # compilado aqui (não é a versão pronta): a IDE se atualiza pelo git e não oferece o Release por cima (update.rs)
  $mark = Join-Path $dest 'local-build.txt'
  if ($S.mode -eq 'build') { [IO.File]::WriteAllText($mark, "compilado do código-fonte pelo Instalar BlueScreen.cmd`r`n", [Text.UTF8Encoding]::new($false)) }
  elseif (Test-Path -LiteralPath $mark) { Remove-Item -LiteralPath $mark -Force }
  $kb = [int]((Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  New-Item $UninstKey -Force | Out-Null
  $props = @{ DisplayName = 'BlueScreen'; DisplayVersion = $S.instVersion; Publisher = 'BlueScreen'; DisplayIcon = "$exe,0"; InstallLocation = $dest
              UninstallString = "`"$(Join-Path $dest 'Desinstalar.cmd')`""; InstallDate = (Get-Date -Format 'yyyyMMdd') }
  foreach ($k in $props.Keys) { New-ItemProperty $UninstKey -Name $k -Value $props[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in @{ NoModify = 1; NoRepair = 1; EstimatedSize = $kb }.GetEnumerator()) { New-ItemProperty $UninstKey -Name $k.Key -Value $k.Value -PropertyType DWord -Force | Out-Null }
  Add-Log 'registrado em Configurações > Apps'
  Set-Target 1; $S.phase = 'done-wait'; $S.deadline = (Get-Date).AddMilliseconds(700)
}
function Show-Done {
  $S.phase = 'idle'; $S.sw.Stop(); Set-Step 4 ok
  $ui.DonePath.Text = $S.dest
  $ui.DoneNote.Text = "Levou $([int]$S.sw.Elapsed.TotalMinutes) min $($S.sw.Elapsed.Seconds) s. Para desinstalar: Configurações › Apps › BlueScreen."
  Show-Page PageDone
  $ui.BadgeS.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, (Anim 0 1 560 (BackOut 0.6)))
  $ui.BadgeS.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, (Anim 0 1 560 (BackOut 0.6)))
  $chk = Anim 12 0 520 (EaseOut); $chk.BeginTime = [TimeSpan]::FromMilliseconds(260)
  $ui.Check.BeginAnimation([Windows.Shapes.Shape]::StrokeDashOffsetProperty, $chk)
  $r = Anim 1 1.7 900 (EaseOut); $r.BeginTime = [TimeSpan]::FromMilliseconds(200)
  $ui.RippleS.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty, $r); $ui.RippleS.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty, $r)
  $o = Anim 0.8 0 900 (EaseOut); $o.BeginTime = [TimeSpan]::FromMilliseconds(200); $ui.Ripple.BeginAnimation([Windows.UIElement]::OpacityProperty, $o)
}
function Fail-Install([string]$msg) {
  Stop-Proc; $S.phase = 'idle'; $S.sw.Stop()
  if ($S.step -ne $null) { Set-Step $S.step bad }
  $ui.FailMsg.Text = $msg
  # o que interessa primeiro: as linhas de erro do cargo; sem elas, o fim do log
  $errs = @($S.lines | Where-Object { $_ -match '^\s*error|^\s*erro|falhou|não foi|exception' })
  $tail = if ($errs.Count) { $errs + '' + '— últimas linhas —' + ($S.lines | Select-Object -Last 25) } else { $S.lines | Select-Object -Last 60 }
  $ui.FailLog.Text = ($tail -join "`n"); $ui.FailLog.ScrollToEnd()
  Show-Page PageFail
}

# ----- relógio da janela: lê saídas, avança fases e anima o número -----
$timer = [Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromMilliseconds(33)
$timer.Add_Tick({
  try {
    # número e barra seguem o alvo com suavidade
    if ($S.shown -lt $S.target) { $S.shown += [Math]::Max(0.0015, ($S.target - $S.shown) * 0.12); if ($S.shown -gt $S.target) { $S.shown = $S.target }
      $ui.Bar.Value = $S.shown * 1000; $ui.Percent.Text = ('{0}%' -f [int][Math]::Floor($S.shown * 100)) }
    if ($S.sw.IsRunning) { $ui.Elapsed.Text = $S.sw.Elapsed.ToString('mm\:ss') }
    if ($S.relTask -and $S.relTask.IsCompleted) { On-ReleaseCheck }
    switch ($S.phase) {
      'closing' {
        if (-not @(Get-Running)) { Start-Work }
        elseif ((Get-Date) -gt $S.deadline) { Fail-Install 'O BlueScreen continua aberto (talvez com arquivos não salvos). Feche-o e tente de novo.' }
      }
      'build' {
        if (Pump ${function:On-BuildLine}) {
          $S.proc.WaitForExit(); $code = $S.proc.ExitCode; $S.proc = $null
          if ($code -ne 0) { Fail-Install "A compilação falhou (código $code). Veja as mensagens do cargo abaixo; o log completo pode ser copiado." }
          elseif (-not (Test-Path (Join-Path $App 'dist\BlueScreen\BlueScreen.exe'))) { Fail-Install 'A compilação terminou, mas app\dist\BlueScreen\BlueScreen.exe não apareceu.' }
          else { Start-Copy }
        }
      }
      'copy' {
        if (Pump ${function:On-CopyLine}) {
          $S.proc.WaitForExit(); $code = $S.proc.ExitCode; $S.proc = $null
          if ($code -ge 8) { Fail-Install "Não foi possível copiar para $($S.dest) (robocopy $code). A pasta está em uso ou sem permissão?" } else { Finish-Install }
        }
      }
      'download' { On-DownloadTick }
      'extract' {
        if (Pump { param($l) }) {
          $S.proc.WaitForExit(); $code = $S.proc.ExitCode; $S.proc = $null
          if ($code -ne 0) { Fail-Install "Não deu para extrair o pacote (tar $code)." }
          elseif (-not (Test-Path (Join-Path $S.src 'BlueScreen.exe'))) { Fail-Install 'O pacote baixado não tem o BlueScreen.exe.' }
          else { Start-Copy }
        }
      }
      'done-wait' { if ($S.shown -ge 0.999 -and (Get-Date) -gt $S.deadline) { Show-Done } }
      'rustup-dl' {
        if ($S.rustupDl.IsCompleted) {
          if ($S.rustupDl.IsFaulted) { $S.phase = 'idle'; Set-Req rust 'Rust' bad ('o download falhou: ' + $S.rustupDl.Exception.InnerException.Message) 'Tentar de novo' { Install-Rust } }
          else { Set-Req rust 'Rust' busy 'siga o instalador do Rust na outra janela…'; $S.rustupProc = Start-Process $S.rustupExe -PassThru; $S.phase = 'rustup' }
        }
      }
      'rustup' { if ($S.rustupProc.HasExited) { $S.phase = 'idle'; Test-Requirements } }
    }
  } catch { Fail-Install ("Erro inesperado no instalador: " + $_.Exception.Message) }
})
$timer.Start()

# ----- botões -----
$ui.BtnInstall.Add_Click({ Start-Install })
$ui.BtnRetry.Add_Click({ Show-Page PageSetup; Test-Requirements })
$ui.BtnCancel.Add_Click({ $ui.BtnCancel.IsEnabled = $false; Stop-Proc; Fail-Install 'Instalação cancelada. Nada foi registrado; a pasta pode ter ficado incompleta se a cópia já tinha começado.' })
$ui.BtnDetails.Add_Click({
  $show = $ui.LogBox.Visibility -ne 'Visible'
  $ui.LogBox.Visibility = if ($show) { 'Visible' } else { 'Collapsed' }; $ui.StepList.Visibility = if ($show) { 'Collapsed' } else { 'Visible' }
  $ui.BtnDetails.Content = if ($show) { 'Ver etapas' } else { 'Ver detalhes' }
  if ($show) { $ui.LogBox.Text = $S.log.ToString(); $ui.LogBox.ScrollToEnd() }
})
$ui.BtnCopyLog.Add_Click({ [Windows.Clipboard]::SetText($S.log.ToString()); $ui.BtnCopyLog.Content = 'Log copiado ✓' })
$ui.BtnLaunch.Add_Click({ Start-Process (Join-Path $S.dest 'BlueScreen.exe') -WorkingDirectory $S.dest; $win.Close() })
foreach ($b in 'BtnDoneClose', 'BtnFailClose', 'BtnClose') { $ui[$b].Add_Click({ $win.Close() }) }
$ui.BtnMin.Add_Click({ $win.WindowState = 'Minimized' })
$ui.TitleBar.Add_MouseLeftButtonDown({ $win.DragMove() })
$ui.Hero.Add_MouseLeftButtonDown({ $win.DragMove() })
$win.Add_Closing({ $timer.Stop(); Stop-Proc })

# erro não tratado num evento da janela: registra em %TEMP%luescreen-setup.log e mostra, em vez de sumir calado
$win.Dispatcher.Add_UnhandledException({ param($s, $e)
  $e.Handled = $true; $msg = $e.Exception.ToString()
  try { [IO.File]::AppendAllText((Join-Path $env:TEMP 'bluescreen-setup.log'), "$(Get-Date -Format s) $msg`r`n") } catch {}
  Fail-Install ('Erro inesperado no instalador: ' + $e.Exception.Message) })

Start-ReleaseCheck
Test-Requirements
[void]$win.ShowDialog()
